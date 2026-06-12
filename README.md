# Critical Ops Slack → Jira Bot

Listens to a Slack channel via Socket Mode and auto-creates Jira tickets from incident messages. Thread replies sync as Jira comments. Runs free on GitHub Actions.

## Setup

1. Add these GitHub Secrets (Settings → Secrets and variables → Actions):
   - `SLACK_BOT_TOKEN` (xoxb-...)
   - `SLACK_APP_TOKEN` (xapp-...)
   - `ABACUSAI_API_KEY`
   - `JIRA_HOST` (e.g. `expansionjs.atlassian.net`)
   - `JIRA_EMAIL`
   - `JIRA_API_TOKEN`
   - `JIRA_PROJECT_KEY` (e.g. `CO`)
   - `SLACK_ALLOWED_CHANNEL_IDS` (comma-separated channel IDs)

2. Go to the **Actions** tab → enable workflows.
3. Manually trigger the first run: **Actions → Critical Ops Bot → Run workflow**.
4. After that it auto-restarts every 6 hours.
