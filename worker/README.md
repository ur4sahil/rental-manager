# Housy worker

Runs on the Oracle LLM box (150.136.226.115), beside Ollama. Deployed as
two systemd services; there is no pm2 on that box.

    housy-proxy    127.0.0.1:11435  auth gate in front of Ollama
    housy-worker   claims ai_jobs from test.housify365.com
    housy-worker-prod   claims ai_jobs from housify365.com

Ollama itself has NO authentication, so the cloudflared tunnel points at
the gate on 11435 and never at 11434.

**The worker holds no database credentials.** It claims work through
`POST /api/ai?action=claim` with a shared token. The Supabase service key
bypasses RLS entirely and that box is a second Always Free tenancy that
can be reclaimed with little warning, so it stays an inference appliance.
`tests/ai-never-posts.test.js` enforces this.

## Deploy

    scp worker/housy-worker.js ubuntu@150.136.226.115:/home/ubuntu/
    ssh ubuntu@150.136.226.115 'sudo systemctl restart housy-worker housy-worker-prod'

Config lives in `/home/ubuntu/.housy-worker.env` and
`.housy-worker-prod.env` (0600, one per environment, different tokens).
