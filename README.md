# API Toolbar

A Chrome and Edge extension for reverse engineering web app APIs. It records a site's API traffic, gives you a curl command for any call, and turns a whole session into a script that runs without the browser. Recording starts from a toolbar button, so you never need to open DevTools.

The script is more than a list of replayed requests. API Toolbar works out how the calls depend on each other, so the script fetches fresh values as it runs:

- **Chained values:** a token from a login response is read at runtime and passed to later calls, instead of pasting in the one you recorded.
- **Loops:** page 1, 2, 3 becomes a loop over every page, and 2 detail calls from a list of 500 becomes a loop over all 500. Results are collected into a JSON lines file.
- **Credentials:** passwords, API keys and browser cookies move out of the script into a separate `.env` file, so the script is safe to share.
- **Dependencies:** tick one call and anything it depends on is added automatically, such as the page that supplies its CSRF token.

Scripts can be exported as **bash**, **Python** or **PowerShell**.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.

4. Pin **API Toolbar** from the extensions menu so its icon stays on the toolbar.

There is no build step. The extension uses the `debugger` permission to record the tab, and the `sidePanel` permission to show the recorder beside the page.

## Use it

### Record

1. Open the site and click the **API Toolbar** icon. The recorder opens beside the page and starts recording that tab.
2. Reload the page if you want the calls it makes while loading.
3. Use the site, then press **Stop**.

Chrome shows a "started debugging this browser" banner while this runs, and no extension can hide it. **Stop** removes the banner, and so does closing the recorder. If the site's login uses a CAPTCHA, log in by hand first and then click the icon. The script reuses that session and skips the login.

To record a different tab, press **Stop**, switch tabs and press **Record**. The browser cache is off while recording, because Chrome only reports the full headers of calls that reach the network.

### See what was captured

Recordings are not saved automatically. They stay in the recorder until you close it, so use **Export** to keep one. **Import** loads it again later.

- Each row is one call or page. **API** hides page assets, and **All** shows everything.
- Calls to other sites, which are mostly ads and analytics, start unticked. Tick any you want in the script.
- Select a row to see its **curl** command, **Request**, **Response** and **Flow**, which shows the values it shares with other calls.
- The **Inputs** column counts the values a call took from earlier responses.

### Make a script

1. Untick anything you don't need, then choose **Make me a bash script**.
2. Pick a language and check the plan.
3. Download the script and its `.env` file, and keep the two files together. They go to your usual downloads folder.

To detect a loop, the recording needs at least two examples: scroll to page 2, or open two items.

### Running a script

| Language | Needs | Run with |
| --- | --- | --- |
| Bash | `curl`, `jq` (`winget install jqlang.jq`) | `bash api_script.sh` |
| Python 3 | `pip install requests` | `python api_script.py` |
| PowerShell 5.1 or 7 | Nothing extra | `powershell -ExecutionPolicy Bypass -File api_script.ps1` |

Responses are saved to `api_script_output/`, in the folder you run the script from, with one file per request. Loop results are combined into `.ndjson` files. The script prints the full path when it starts.

If a step fails, the script stops and names the file holding that response. Steps that already ran keep their files.

These environment variables are optional:

| Variable | Default | Effect |
| --- | --- | --- |
| `OUT_DIR` | `./api_script_output` | Where responses are saved |
| `MAX_PAGES` | `100` | Stops a page loop after this many pages |
| `MAX_ITEMS` | `1000` | Stops a for-each loop after this many items |
| `DELAY` | `0.2` | Seconds to wait between loop requests |

## Before you run a script

The **Check before running** list in the script view flags the problems it can see. These are the ones to watch for:

- **Scripts repeat real actions.** A recorded POST or DELETE runs again every time. For-each loops are only built for read requests, so a recorded delete never widens to everything in a list.
- **Scripts can't pass a CAPTCHA.** CAPTCHA and tracker calls stay out of scripts unless you tick them, and a login behind a CAPTCHA is flagged. Log in by hand and record after that instead.
- **Credentials expire.** Sessions and tokens in the `.env` file stop working eventually, and JWT expiry dates are shown in the warnings. Recording a login makes the script log in for itself, which avoids this.
- **Some requests can't be replayed.** If a header is computed by the page's JavaScript, such as a request signature, the panel warns about it, but the script can't recreate it. Sites that fingerprint browsers may block these scripts too.
- **Some calls are not recorded.** Only the tab's own page is captured, so calls made from cross-site iframes or web workers won't appear.
- **Uploads and WebSockets are not replayed.** Chrome doesn't expose uploaded file contents, and scripts only make HTTP requests.
- **Exports contain secrets.** HAR exports and `.env` files hold whatever was recorded, including live credentials.

Value links are found by matching, so an occasional one may be wrong. Each link is listed in the plan with a checkbox, and unticking it keeps the recorded value instead.

## How scripts are generated

```
Recording  ->  Plan  ->  Template + dialect  ->  Script
```

- **The plan** ([src/lib/plan.js](src/lib/plan.js)) is language-neutral. It decides the steps, the values passed between them, the loops, and what the user must supply.
- **Templates** ([src/templates/](src/templates/)) are real `.sh`, `.py` and `.ps1` files that hold each script's shape: its setup, helper functions, and a snippet for each kind of step. Edit one to change what every generated script looks like.
- **Dialects** ([src/lib/dialects/](src/lib/dialects/)) only know how a language quotes strings and writes expressions.

### Template syntax

```
{{name}}          Replaced with a value.
# @if name        Keeps the block when the value is set. @else also works.
# @helper name    Keeps the block only if the script calls name.
# @snippet name   A block rendered for each step that needs it.
# @end            Closes any of the blocks above.
```

Each template defines these snippets: `request`, `extract`, `counter_loop`, `cursor_loop`, `next_url_loop` and `foreach_loop`.

### Adding a language

1. Add a template to `src/templates/`, using the existing ones as a guide.
2. Add a dialect to `src/lib/dialects/` that spells out quoting and expressions.
3. Add it to `LANGUAGES` in [src/lib/generate.js](src/lib/generate.js).

Quoting is the part to get right, because captured data is untrusted and a hostile server chooses what ends up in your script. Add the language to the hostile replay test in [test/run-scripts.test.js](test/run-scripts.test.js).

## Tests

```
npm test            # Unit tests, plus scripts run against a live mock server
npm run test:e2e    # The real extension in a headless browser
```

Neither needs `npm install`. The browser test uses an installed browser with a throwaway profile, and `E2E_BROWSER` chooses which one. It needs a browser that honours `--load-extension`, such as Edge, Chromium or Chrome for Testing. Branded Chrome ignores that flag, so it can only be checked by hand with **Load unpacked**. Headless browsers have no toolbar to click, so the test opens the recorder as a tab and confirms that the icon is set to open the side panel.

`npm test` runs generated scripts for real. If `jq` or `requests` isn't installed, it uses the small stand-ins in `test/fixtures/stand-ins/` and says so in the test name. These cover what scripts use but are not the real tools, so install both for a full check.
