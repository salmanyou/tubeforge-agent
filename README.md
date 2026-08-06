# Tube Forge Agent

An autonomous metadata-optimization agent for your YouTube channel. On a schedule, it:

1. Pulls your real video stats through the YouTube Data API
2. Scores each video's title/tags/description with a transparent rubric
3. Asks an AI to draft better metadata, using real trending search phrases
4. **Actually applies the update** to your live video — through YouTube's official write API, using your own login
5. **Checks its own work** ~7-14 days later against real view velocity (not just the rule-based score), and gets stricter automatically if its changes aren't actually helping
6. Logs everything, so the `index.html` dashboard in this repo shows real before/after progress

## Straight answer: what's real right now vs. what needs you to finish setup

- OAuth + reading your real channel data: works, confirmed.
- The scoring, safety-gate, and now the outcome-tracking logic: tested against simulated data, confirmed working correctly.
- Actually publishing a change to a real video: works mechanically (`videos.update` is a standard, well-supported call) but only runs when you run it — either manually or once deployed.
- Running 24/7 unattended: **only true once you've completed Section 3 below** (push to GitHub, add secrets, let Actions take over). Until then this only does anything when you type `npm run agent` yourself.
- "Best possible" version: there's no ceiling to that, realistically — see Section 4 for what "better than this" would concretely mean, and Section 5 for the honest limits of what metadata optimization alone can do for channel growth.

This is a different thing from the read-only browser dashboard you had before. That one used an API **key**, which can only *read* public data — it can't change anything on your channel. To actually write metadata, YouTube requires **OAuth** (you, personally, granting the app permission), which is what this agent uses.

---

## 1. One-time Google Cloud setup (~5 minutes)

The API key you already made won't work for this — you need an **OAuth Client ID**, from the same project:

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) (same project where you enabled YouTube Data API v3).
2. **Create Credentials → OAuth client ID**.
3. If prompted, configure the **OAuth consent screen** first:
   - User type: **External**
   - App name / support email: anything, it's just for you
   - Scopes: skip, we add it in code
   - Test users: add your own Google account email
4. Back at "Create OAuth client ID": Application type = **Desktop app**. Name it anything. Create.
5. Copy the **Client ID** and **Client Secret**.
6. **Important:** on the OAuth consent screen page, set **Publishing status** to **"In production"** (not "Testing"). You do *not* need to submit for Google's verification — that's only required if the public will use your app. Since only you will ever authorize it, you can publish without review. You'll see an "unverified app" warning during login; that's expected and safe to click through, since you're authorizing your own app to act as your own account. Staying in "Testing" mode instead works too, but Google expires the login every 7 days, which defeats the point of a 24/7 agent.

## 2. Local setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
```
YT_CLIENT_ID=your client id
YT_CLIENT_SECRET=your client secret
CHANNEL_HANDLE=@yourhandle
```

Run the one-time authorization:
```bash
npm run authorize
```
This opens a URL for you to approve in a browser, then prints a `YT_REFRESH_TOKEN` — paste it into `.env`.

Edit `config.json` to describe your channel (niche, audience, voice) — the AI uses this to keep suggestions on-brand instead of generic.

**AI backend — recommended: Gemini, genuinely free.** Unlike Pollinations (which just started requiring payment for anonymous use — see below) or OpenAI (only gives expiring trial credits), Google's Gemini API has a real, permanent free tier: no credit card, no expiry, generous enough limits that this agent (a handful of requests every few hours) won't come close to hitting them.

1. Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**, sign in with any Google account, click **Create API key**. No billing setup needed.
2. Add it to `.env`:
   ```
   GEMINI_API_KEY=your key here
   ```
That's it — `ai.js` already checks for this and uses it automatically. (It tries Anthropic first if you've set that key, then Gemini, then Pollinations as a last resort — you only need one of these filled in.)

Test it without touching your real videos:
```bash
npm run agent:dry
```
This runs the full pipeline and prints exactly what it *would* change, but doesn't call the write API. Once you're happy with the output, run it for real:
```bash
npm run agent
```

## 3. Making it run 24/7 (not just while your laptop's open)

A browser tab or a script on your own machine only runs while that machine is on — that's not "always on." The realistic way to get true unattended automation without renting a server is **GitHub Actions**, which is free for this workload and already wired up in `.github/workflows/agent.yml`.

1. Push this folder to a new GitHub repo (`git init && git add . && git commit -m "init" && git remote add origin <your-repo-url> && git push -u origin main`).
2. In the repo: **Settings → Secrets and variables → Actions**, add:
   - `YT_CLIENT_ID`
   - `YT_CLIENT_SECRET`
   - `YT_REFRESH_TOKEN`
   - `CHANNEL_HANDLE`
   - `ANTHROPIC_API_KEY` (optional — only if you want to use the Anthropic API instead of the free default)
3. That's it. The workflow runs every 6 hours automatically (edit the `cron:` line in the workflow file to change frequency), and you can also trigger a run manually from the **Actions** tab any time.
4. Each run commits the updated `data/state.json` and `data/history.jsonl` back to the repo — which is what makes the dashboard "live."

**To see the dashboard online:** Settings → Pages → Deploy from branch → `main` → `/ (root)`. GitHub gives you a URL like `https://yourname.github.io/tubeforge-agent/` — open it, click the **Autopilot** tab, and you'll see the agent's real activity, refreshed every time it runs.

## 4. Why it isn't 100% blind auto-apply, and why that's the "best of best" version

You asked for the smartest, most hands-off version — here's what that actually means in practice, not just in theory:

- **Score gate**: a change only gets applied if the new metadata scores meaningfully higher than the old one (`minScoreGainToApply` in `config.json`). Otherwise it's just noise.
- **Rate limit per video**: each video is only touched once every `rateLimitDaysPerVideo` days (default 7). YouTube's systems pay attention to metadata churn — editing the same video's title daily looks like manipulation even when every individual edit is genuine, and can suppress the video while it gets re-reviewed. This limit is what lets the agent run *fully unattended* without that risk.
- **Review flag for big rewrites**: if a proposed title is a near-total rewrite (not a polish), it's queued on the **Autopilot** tab instead of auto-published. Everything else — the vast majority of changes — applies automatically with zero input from you.
- **Link preservation**: if your original description had links, the rewrite keeps them, even if the AI draft forgot to.
- **Full audit trail with rollback data**: `data/history.jsonl` keeps the *before* value of everything changed, so you can always revert manually in YouTube Studio if a specific edit turns out to be wrong.
- **Real outcome tracking (not just the score)**: every run snapshots each video's view count. ~7-14 days after a change is applied, the agent compares view velocity before vs. after and logs a verdict (`improved` / `flat` / `declined`) — not a guess, an actual measurement from the data it's been collecting. Once there's a handful of judged changes, the required score-gain threshold auto-adjusts: if changes aren't panning out, it gets stricter on its own; if they are, it leaves the base threshold alone. Check the **Autopilot** tab's "Track Record" card to see this live. Honest caveat: with a small channel, this needs a while to accumulate enough judged changes (and view-count noise) to say anything statistically meaningful — the machinery is real and running from day one, but treat single-digit sample sizes as early signal, not proof.

You can loosen any of these in `config.json` — e.g. set `requireHumanReviewAboveTitleChangePercent` to `100` to never queue anything for review. I'd genuinely recommend against turning the score gate or rate limit off entirely; those aren't caution for its own sake, they're what stops the agent from fighting itself (rewriting a video, then rewriting it again a day later because the AI's opinion drifted) which is the actual failure mode that tanks channels running "full auto" tools.

## 5. What this doesn't do (and one honest caveat)

- It doesn't touch views, likes, comments, or subscribers — that's fake engagement and against YouTube's rules; this agent only edits your own metadata through the legitimate write API, same as editing it by hand in Studio.
- It doesn't upload new videos or design thumbnails (only metadata: title, description, tags). Ask if you want that added — it's a reasonable next step (YouTube's API does support video upload) but is a bigger scope than metadata optimization.
- Metadata optimization moves search relevance and click-through; it doesn't substitute for retention, thumbnails, or upload consistency, which matter more for growth than titles alone. Treat this as one lever, not the whole strategy.

## Project layout

```
config.json          channel niche/voice + automation thresholds
.env / .env.example   credentials (never commit .env)
src/auth.js           OAuth client
src/youtube.js        YouTube Data API reads + writes
src/ai.js             metadata generation (Pollinations by default, Anthropic optional)
src/scorer.js         transparent scoring rubric
src/safety.js         apply / review / reject decision logic
src/agent.js          orchestration — this is what cron/Actions runs
scripts/authorize.js  one-time OAuth login
data/state.json       machine-readable snapshot the dashboard reads
data/history.jsonl    append-only log of every decision made
index.html            the dashboard (your original tool + a new "Autopilot" tab)
.github/workflows/     the actual 24/7 scheduler
```
