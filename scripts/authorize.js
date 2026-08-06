// Run once, locally, with a real browser handy: `npm run authorize`
// Walks you through Google's consent screen and prints the refresh token you
// need to paste into .env (local runs) or into a GitHub Actions secret (cron runs).

const http = require('http');
const { URL } = require('url');
const { getOAuthClient, REDIRECT_URI, SCOPES } = require('../src/auth');

async function main() {
  const client = getOAuthClient();

  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token, not just an access_token
    prompt: 'consent',      // forces Google to re-issue a refresh_token even on repeat runs
    scope: SCOPES,
  });

  console.log('\n1. Open this URL in a browser signed into the Google account that owns your channel:\n');
  console.log(authUrl);
  console.log('\n2. You will very likely see an "unverified app" warning — that is expected for a');
  console.log('   personal script. Click "Advanced" → "Go to (your app name) (unsafe)" to continue.');
  console.log('   You are authorizing your own app to act as your own account, so this is safe.\n');
  console.log('Waiting for you to approve access...\n');

  const code = await waitForRedirectCode();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      '\nNo refresh_token came back. This usually means you already authorized this app before.\n' +
      'Go to https://myaccount.google.com/permissions, remove access for this app, and run this script again.'
    );
    process.exit(1);
  }

  console.log('\n✅ Success. Add this to your .env file (local runs):\n');
  console.log(`YT_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nFor 24/7 automation via GitHub Actions, add the same value as a repo secret named YT_REFRESH_TOKEN instead.');
  console.log('(Settings → Secrets and variables → Actions → New repository secret)\n');
}

function waitForRedirectCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') { res.end(); return; }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html');
      if (error) {
        res.end(`<h2>Authorization failed: ${error}</h2>You can close this tab.`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end('<h2>Authorized ✅</h2>You can close this tab and return to the terminal.');
      server.close();
      resolve(code);
    });
    server.listen(8765);
  });
}

main().catch(err => {
  console.error('\nAuthorization failed:', err.message);
  process.exit(1);
});
