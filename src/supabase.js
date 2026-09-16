import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing REACT_APP_SUPABASE_URL or REACT_APP_SUPABASE_ANON_KEY environment variables')
}

// ---------------------------------------------------------------------------
// TRUNCATION DETECTION
//
// Supabase caps every PostgREST response at 1000 rows. PostgREST's own default
// is unlimited; the cap is Supabase's, and it guards a public HTTP endpoint
// against one request pulling an entire table. Fair enough.
//
// The danger is not the cap. It is that the SERVER announces it and the CLIENT
// throws the announcement away. Ask for 16,747 rows and the wire says:
//
//     HTTP/1.1 206 Partial Content
//     content-range: 0-999/16747
//
// -- explicit, unambiguous, correct. But supabase-js hands the caller
// { data, error }: error is null, data.length is 1000, and neither the 206 nor
// the Content-Range survives. The caller sees a successful query returning a
// plausible array, and the only way to notice is to already suspect it.
//
// That failure shape cost real money in this codebase, three times in one day:
//
//   * an account ledger's opening balance summed the first 1000 of 1516 lines
//     and opened at 45,291.34 instead of 40,921.73;
//   * the same query behind the balance sheet, so the two disagreed by
//     4,369.61 with no indication which was right;
//   * a bank reconciliation verified 1000 of 2412 lines, flagged exactly those,
//     and wrote a record claiming 2412 -- a reconciliation that asserted a
//     closed period over a ledger where 1412 lines were still open.
//
// None raised an error. Every one produced a believable number.
//
// QuickBooks and Xero paginate too, but their responses carry the pagination
// INTO THE BODY -- QuickBooks returns maxResults/startPosition, Xero a
// pagination object with pageCount and itemCount. You cannot consume their
// payload without meeting the fact that there is more. Supabase puts it in a
// header the SDK discards, so the same class of bug is invisible here and
// impossible there.
//
// The fix below restores what the protocol already said. Every select that
// comes back at exactly the cap is re-checked for a true count, and a genuine
// truncation is turned into a real error -- which is what the caller would
// have received from any API that reported this properly.
const MAX_ROWS = 1000

// A count query costs a round trip, so only pay it when truncation is actually
// possible: the response is exactly the cap. Under it, nothing was cut.
async function assertNotTruncated(result, context, rerunForCount, deliberate) {
  try {
    if (!result || result.error || !Array.isArray(result.data)) return result
    if (result.data.length !== MAX_ROWS) return result
    // A caller that PAGED is not being truncated, whatever the count says.
    //
    // This check used to sit only in front of the count RE-FETCH, while the
    // count the caller had already requested was read unconditionally below.
    // So a paged query that asked for { count: "exact" } -- which is how you
    // page properly, since you need the total to know when to stop -- was
    // refused on its own first page. That is precisely the Bank Transactions
    // fetch: range(0,999) with count exact over 1,060 rows. The guard handed
    // it data:null and the screen rendered nothing at all.
    //
    // A guard that blanks a working page is worse than the silent truncation
    // it was written to catch.
    if (deliberate) return result
    // Exactly 1000 rows. Either the table holds exactly 1000 matching rows, or
    // we have been truncated. `count` distinguishes them, and supabase-js does
    // surface it when asked for -- callers that already pass { count } get it
    // here for free.
    //
    // Only 13 of this codebase's 469 selects ask for a count, so relying on the
    // caller to have requested one would leave the guard covering almost
    // nothing. When we cannot tell from the result, ASK -- head:true fetches
    // the count with no rows, so the extra round trip carries no payload and
    // only ever happens on the exact-1000 boundary.
    let total = typeof result.count === 'number' ? result.count : null
    if (total === null && rerunForCount) {
      try {
        const { count } = await rerunForCount()
        total = typeof count === 'number' ? count : null
      } catch (_e) { total = null }
    }

    if (typeof total === 'number' && total > result.data.length) {
      const err = new Error(
        `Query returned ${result.data.length} rows but ${total} match. ` +
        `Supabase caps responses at ${MAX_ROWS}: page this query (fetchAllPaged) ` +
        `or narrow it.${context ? ' [' + context + ']' : ''}`
      )
      err.code = 'PM_TRUNCATED'
      // Refusing is the point. A caller that silently sums a truncated array
      // produces a wrong number nobody can see; a caller handed an error
      // produces a visible failure, and every call site in this app already
      // handles { error }.
      return { ...result, data: null, error: err }
    }
    return result
  } catch (_e) {
    // A guard must never be the thing that breaks a query.
    return result
  }
}

const client = createClient(supabaseUrl, supabaseKey)

// Wrap the builder returned by .select(), because that is where `then` lives.
//
// .from() gives a PostgrestQueryBuilder with NO then -- it is not awaitable.
// .select()/.update()/.delete() give a PostgrestFilterBuilder, which IS a
// thenable: it accumulates filters until awaited. That is the only point that
// sees the finished result, and patching it means no caller has to opt in, no
// new helper has to be remembered, and code written next year is covered.
//
// Verified against the SDK rather than assumed: an earlier version of this
// patched .from() and would have silently done nothing at all.
const nativeFrom = client.from.bind(client)
client.from = function guardedFrom(table) {
  const qb = nativeFrom(table)
  const nativeSelect = qb.select.bind(qb)
  qb.select = function guardedSelect(...args) {
    const fb = nativeSelect(...args)
    if (typeof fb.then !== 'function') return fb
    const nativeThen = fb.then.bind(fb)
    fb.then = function guardedThen(onFulfilled, onRejected) {
      return nativeThen(
        async result => {
          // An explicit .range() or .limit() is the caller SAYING they want a
          // page. Only an UNBOUNDED select can be truncated without anybody
          // asking for it.
          //
          // .limit() lands in the URL as ?limit=. .range() does NOT: it sends
          // an HTTP Range header and leaves the URL bare. Checking only the
          // URL therefore read every .range() page as unbounded -- and since
          // a full page IS exactly MAX_ROWS, the guard refused it and returned
          // data:null. That emptied the whole Bank Transactions screen: its
          // fetch is range(0,999) over 1,060 rows, so the first page was
          // rejected and the page rendered nothing at all.
          //
          // A guard that blanks a working screen is worse than the silent
          // truncation it was written to catch. Both forms are checked now.
          const asked = (() => {
            try {
              const p = new URL(fb.url.toString()).searchParams
              if (p.has('limit') || p.has('offset')) return true
            } catch (_e) { return true }   // unreadable URL: assume deliberate
            // supabase-js stores .range() as a Range header on the builder.
            const h = fb.headers || {}
            return !!(h.Range || h.range || h['Range-Unit'])
          })()
          const boundary = !asked && Array.isArray(result?.data) && result.data.length === MAX_ROWS
          // Ask the SDK for the count, on a fresh builder carrying the SAME
          // filters. Reusing fb.url with fetch() was the obvious move and it
          // does not work: the auth headers live on the CLIENT, not on the
          // builder, so fb.headers is empty and a hand-rolled request gets a
          // 401 -- which this guard would swallow, leaving the truncation
          // exactly as silent as before.
          //
          // fb.url still supplies the filters. Everything after "select=" is
          // the filter set PostgREST was actually given, replayed verbatim so
          // the count cannot drift from the query it counts.
          const rerun = async () => {
            const u = new URL(fb.url.toString())
            let q = nativeFrom(table).select('*', { count: 'exact', head: true })
            u.searchParams.forEach((value, key) => {
              if (['select', 'limit', 'offset', 'order'].includes(key)) return
              // PostgREST filter syntax is "col=op.value"; the SDK's generic
              // .filter() speaks exactly that, so no operator needs decoding.
              const dot = value.indexOf('.')
              if (dot > 0) q = q.filter(key, value.slice(0, dot), value.slice(dot + 1))
            })
            const { count } = await q
            return { count: typeof count === 'number' ? count : null }
          }
          const checked = await assertNotTruncated(result, table, boundary ? rerun : null, asked)
          return onFulfilled ? onFulfilled(checked) : checked
        },
        onRejected
      )
    }
    return fb
  }
  return qb
}

export const supabase = client

// Exported for the tests, which assert the rule rather than trusting it.
export const _truncation = { MAX_ROWS, assertNotTruncated }
