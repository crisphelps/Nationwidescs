# Resource Deliverables Slack App - Deployment Guide

## What It Does

Employees post a message containing "resource deliverables" with a ZIP file attached. The automation:
1. Extracts photos from the ZIP
2. Analyzes each with Claude's vision (identifies racks, APs, patch panels, etc.)
3. Renames them intelligently (Rack-MDF-01, AP-Ceiling-CLOSE-02, etc.)
4. Re-compresses and posts the result back to the same channel

Works with slash command `/resource-deliverables` too.

---

## Setup (15 minutes)

### Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. **App Name:** `Resource Deliverables`
5. **Workspace:** Select your Nationwide SCS workspace
6. Click **"Create App"**

### Step 2: Configure App Permissions

In the left sidebar, click **"OAuth & Permissions"**

Under **"Scopes"** → **"Bot Token Scopes"**, add:
- `chat:write`
- `files:read`
- `files:write`
- `reactions:write`
- `commands`

### Step 3: Set Up Slash Command

In the left sidebar, click **"Slash Commands"**
- Click **"Create New Command"**
- **Command:** `/resource-deliverables`
- **Request URL:** `https://YOUR-VERCEL-DOMAIN.vercel.app/slack/events` (update after deployment)
- **Short Description:** `Process and rename resource deliverables`
- Click **"Save"**

### Step 4: Enable Event Subscriptions

In the left sidebar, click **"Event Subscriptions"**
- Toggle **"Enable Events"** to ON
- **Request URL:** `https://YOUR-VERCEL-DOMAIN.vercel.app/slack/events` (update after deployment)
- Slack will verify the URL (it will fail until you deploy)

Under **"Subscribe to bot events"**, add:
- `message.channels` (to listen for "resource deliverables" messages)

Click **"Save Changes"**

### Step 5: Install App to Workspace

In the left sidebar, click **"Install App"**
- Click **"Install to Workspace"**
- Authorize the requested permissions
- You'll be given a **Bot User OAuth Token** (looks like `xoxb-...`)
- Save this—you'll need it in Step 7

### Step 6: Get Signing Secret

In the left sidebar, click **"Basic Information"**
- Under **"App Credentials"**, find **"Signing Secret"**
- Copy this value—you'll need it in Step 7

### Step 7: Deploy to Vercel

**Prerequisites:**
- A free Vercel account (https://vercel.com)
- GitHub repo with the app files (or use Vercel's CLI)

**Option A: Deploy via GitHub (easiest)**
1. Create a GitHub repo with these files:
   - `resource-deliverables-app.js`
   - `package.json`
   - `vercel.json`

2. Go to https://vercel.com/import
3. Authorize GitHub
4. Select your repo
5. Vercel detects it's Node.js automatically
6. Under **"Environment Variables"**, add:
   - `SLACK_BOT_TOKEN` = (from Step 5)
   - `SLACK_SIGNING_SECRET` = (from Step 6)
   - `ANTHROPIC_API_KEY` = (your Anthropic API key)
7. Click **"Deploy"**
8. Wait for deployment to complete
9. Copy the **Vercel URL** (looks like `https://resource-deliverables.vercel.app`)

**Option B: Deploy via Vercel CLI**
```bash
npm install -g vercel
vercel login
vercel --prod
# Enter environment variables when prompted
```

### Step 8: Update Slack App URLs

Go back to https://api.slack.com/apps and select your Resource Deliverables app

**In Slash Commands:**
- Edit `/resource-deliverables`
- **Request URL:** `https://YOUR-VERCEL-URL.vercel.app/slack/events`
- Save

**In Event Subscriptions:**
- **Request URL:** `https://YOUR-VERCEL-URL.vercel.app/slack/events`
- Slack should show "Verified" in green
- Save Changes

### Step 9: Test It

In any Slack channel:
1. Upload a ZIP file with photos
2. Post a message: `resource deliverables` in the thread or same message
3. Watch the automation:
   - Hourglass reaction appears (processing)
   - Photos are analyzed and renamed
   - ZIP file is posted back
   - Checkmark reaction appears when done

Or type `/resource-deliverables` and follow the prompt.

---

## Troubleshooting

**"Request URL could not be verified"**
- Vercel app may still be deploying. Wait 2 minutes and try again.
- Check that your Vercel URL is correct (no trailing slash).
- Verify the app is running: visit `https://YOUR-VERCEL-URL.vercel.app/health`

**"No files found in attachment"**
- User didn't attach a file, or the file format isn't ZIP.
- Ensure photos are in a ZIP before uploading.

**Photos not renamed correctly**
- Claude's vision may misidentify some images.
- Common misses: blurry photos, extreme angles, poor lighting.
- You can spot-check the results before sharing.

**Timeout error**
- Large ZIP files (100+ photos) can take >30 seconds.
- Slack has a 3-second response window for slash commands.
- Solution: Use the message trigger instead (`resource deliverables` message).

---

## How Your Team Uses It

**Workflow:**
1. Tech returns from site with photos on their laptop
2. They compress photos into a ZIP: `site-photos.zip`
3. They post to the project channel: "resource deliverables" (message or slash command)
4. Attach the ZIP
5. Hit send
6. Automation runs (30-60 seconds depending on file count)
7. Renamed ZIP appears in the channel thread, ready for the closing report

**No setup needed by team members.** They just post the file and say the magic words.

---

## Cost

- **Vercel:** Free tier (256MB RAM, no cold starts beyond first request/hour)
- **Claude API:** ~$0.01-0.05 per batch of 10 photos (vision analysis)
- **Slack:** No additional cost

Expected cost for 100 batches/month: ~$2-5 on the Claude API.

---

## Support

If something breaks:
1. Check Vercel logs: https://vercel.com/dashboard → your project → Logs
2. Check Slack app logs: https://api.slack.com/apps → your app → "View Logs"
3. Verify environment variables are set in Vercel
4. Make sure Slack app is reinstalled after any permission changes

---

## Next Steps

Once this is live, you can:
- Create a shared Slack reminder to use `/resource-deliverables` for all closing reports
- Add other triggers (e.g., "extract photos", "compress files")
- Monitor which teams use it most
- Extend to other workflows (e.g., auto-post to closing report generator)
