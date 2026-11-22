/**
 * Google Apps Script: fetch NHL standings and commit them to standings.json on GitHub.
 *
 * Two ways it runs:
 *  - On a schedule: every 30 minutes, but only between 1:00 PM and 1:30 AM Eastern
 *    (when games are played). Outside that window the trigger fires and exits at once.
 *  - On demand: deployed as a web app, the "Refresh scores" button on nhl-standings.html
 *    calls doGet(), which updates GitHub and returns the fresh standings to the page.
 *
 * Setup:
 * 1) Project Settings > Script properties:
 *    - GITHUB_TOKEN   : GitHub PAT with contents write access to the repo
 *    - GITHUB_OWNER   : benolivr
 *    - GITHUB_REPO    : benolivr.github.io
 *    - GITHUB_BRANCH  : main (optional)
 *    - GITHUB_PATH    : standings.json (optional)
 *    - NHL_API_URL    : optional, defaults to the NHL standings endpoint
 *    - USER_AGENT     : optional
 * 2) Run setupTrigger() once. It removes the old triggers and creates the 30-minute one.
 * 3) Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *    Paste the /exec URL into REFRESH_URL in nhl-standings.html.
 *    After editing this script later, use Deploy > Manage deployments > Edit > New version,
 *    so the same /exec URL keeps working.
 */

var TIME_ZONE = 'America/New_York';
var WINDOW_START_MINUTES = 13 * 60;   // 1:00 PM Eastern
var WINDOW_END_MINUTES = 1 * 60 + 30; // 1:30 AM Eastern (next day)
var MANUAL_COOLDOWN_SECONDS = 300;    // at most one real fetch per 5 minutes from the button
var CACHE_KEY = 'standingsRaw';

/** Trigger handler: runs every 30 minutes, does work only inside the game window. */
function scheduledUpdate() {
  if (!isInGameWindow_(new Date())) {
    return;
  }
  updateNhlStandingsToGitHub();
}

/**
 * Web app endpoint for the "Refresh scores" button.
 * Returns {ok, refreshed, standings...}. Anyone can call it, so it is rate limited:
 * within the cooldown it returns the last fetched standings instead of hitting the APIs.
 */
function doGet() {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(CACHE_KEY);
    if (cached && cache.get('manualCooldown')) {
      return json_({ ok: true, refreshed: false, data: JSON.parse(cached) });
    }
    cache.put('manualCooldown', '1', MANUAL_COOLDOWN_SECONDS);
    var raw = updateNhlStandingsToGitHub();
    return json_({ ok: true, refreshed: true, data: JSON.parse(raw) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Fetches standings, commits them if they changed, and returns the raw JSON text. */
function updateNhlStandingsToGitHub() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another update is already running.');
  }
  try {
    var config = getScriptConfig_();
    if (!config.GITHUB_TOKEN || !config.GITHUB_OWNER || !config.GITHUB_REPO) {
      throw new Error('Missing required script properties. Check GITHUB_TOKEN/OWNER/REPO.');
    }

    var nhlResponse = UrlFetchApp.fetch(config.NHL_API_URL, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'User-Agent': config.USER_AGENT, 'Accept': 'application/json' }
    });
    if (nhlResponse.getResponseCode() !== 200) {
      throw new Error('NHL API request failed with HTTP ' + nhlResponse.getResponseCode());
    }

    var standingsRaw = nhlResponse.getContentText();
    JSON.parse(standingsRaw); // validate before upload

    // Cache for the web app (limit is 100 KB per value; standings are ~60 KB).
    try {
      CacheService.getScriptCache().put(CACHE_KEY, standingsRaw, 21600);
    } catch (e) {
      Logger.log('Could not cache standings: ' + e);
    }

    var githubFileMeta = getGitHubFileMeta_(config);
    if (normalizeJson_(githubFileMeta.contentText) === normalizeJson_(standingsRaw)) {
      Logger.log('No standings change detected. Skipping commit.');
      return standingsRaw;
    }

    var payload = {
      message: 'chore: update standings.json (Apps Script)',
      content: Utilities.base64Encode(standingsRaw, Utilities.Charset.UTF_8),
      branch: config.GITHUB_BRANCH
    };
    if (githubFileMeta.sha) {
      payload.sha = githubFileMeta.sha;
    }

    var uploadResponse = UrlFetchApp.fetch(buildGitHubContentsUrl_(config), {
      method: 'put',
      muteHttpExceptions: true,
      contentType: 'application/json',
      headers: githubHeaders_(config.GITHUB_TOKEN),
      payload: JSON.stringify(payload)
    });
    var code = uploadResponse.getResponseCode();
    if (code !== 200 && code !== 201) {
      throw new Error('GitHub upload failed with HTTP ' + code + ': ' + uploadResponse.getContentText());
    }

    Logger.log('standings.json updated successfully.');
    return standingsRaw;
  } finally {
    lock.releaseLock();
  }
}

/** True between 1:00 PM and 1:30 AM Eastern. Uses the Eastern clock, so DST is handled. */
function isInGameWindow_(date) {
  var hm = Utilities.formatDate(date, TIME_ZONE, 'H:mm').split(':');
  var minutes = Number(hm[0]) * 60 + Number(hm[1]);
  return minutes >= WINDOW_START_MINUTES || minutes < WINDOW_END_MINUTES;
}

/** Run once: replaces any old triggers with a 30-minute trigger on scheduledUpdate. */
function setupTrigger() {
  removeAllTriggers();
  // Apps Script only allows everyMinutes(1, 5, 10, 15 or 30).
  ScriptApp.newTrigger('scheduledUpdate').timeBased().everyMinutes(30).create();
  Logger.log('Created 30-minute trigger for scheduledUpdate (active 1:00 PM to 1:30 AM Eastern).');
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    var fn = trigger.getHandlerFunction();
    if (fn === 'scheduledUpdate' || fn === 'updateNhlStandingsToGitHub') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getScriptConfig_() {
  var p = PropertiesService.getScriptProperties();
  return {
    GITHUB_TOKEN: p.getProperty('GITHUB_TOKEN'),
    GITHUB_OWNER: p.getProperty('GITHUB_OWNER'),
    GITHUB_REPO: p.getProperty('GITHUB_REPO'),
    GITHUB_BRANCH: p.getProperty('GITHUB_BRANCH') || 'main',
    GITHUB_PATH: p.getProperty('GITHUB_PATH') || 'standings.json',
    NHL_API_URL: p.getProperty('NHL_API_URL') || 'https://api-web.nhle.com/v1/standings/now',
    USER_AGENT: p.getProperty('USER_AGENT') || 'benolivr.github.io-standings-updater/1.0 (GoogleAppsScript)'
  };
}

function buildGitHubContentsUrl_(config) {
  return 'https://api.github.com/repos/' +
    encodeURIComponent(config.GITHUB_OWNER) + '/' +
    encodeURIComponent(config.GITHUB_REPO) +
    '/contents/' +
    config.GITHUB_PATH.split('/').map(encodeURIComponent).join('/');
}

function githubHeaders_(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function getGitHubFileMeta_(config) {
  var url = buildGitHubContentsUrl_(config) + '?ref=' + encodeURIComponent(config.GITHUB_BRANCH);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: githubHeaders_(config.GITHUB_TOKEN)
  });

  var code = response.getResponseCode();
  if (code === 404) {
    return { sha: null, contentText: '' };
  }
  if (code !== 200) {
    throw new Error('GitHub read failed with HTTP ' + code + ': ' + response.getContentText());
  }

  var data = JSON.parse(response.getContentText());
  var decoded = '';
  if (data.content) {
    decoded = Utilities.newBlob(Utilities.base64Decode(data.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  }
  return { sha: data.sha, contentText: decoded };
}

function normalizeJson_(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch (e) {
    return text.trim();
  }
}
