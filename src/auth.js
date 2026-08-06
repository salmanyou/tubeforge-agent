const { google } = require('googleapis');
require('dotenv').config();

const REDIRECT_URI = 'http://localhost:8765/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

function getOAuthClient() {
  const { YT_CLIENT_ID, YT_CLIENT_SECRET } = process.env;
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET) {
    throw new Error(
      'Missing YT_CLIENT_ID / YT_CLIENT_SECRET. Create OAuth credentials in Google Cloud Console ' +
      '(see README "Setup" section) and put them in .env.'
    );
  }
  return new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, REDIRECT_URI);
}

// For the long-running agent: builds an authenticated client from the stored refresh token.
function getAuthenticatedClient() {
  const client = getOAuthClient();
  const refreshToken = process.env.YT_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('Missing YT_REFRESH_TOKEN. Run `npm run authorize` once first.');
  }
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

module.exports = { getOAuthClient, getAuthenticatedClient, REDIRECT_URI, SCOPES };
