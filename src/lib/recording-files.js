// Names for what a recording saves. Everything from one recording goes in one
// dated folder inside the browser's downloads folder.
const pad = (value) => String(value).padStart(2, '0');

// Local time, because that is what someone looks for in a folder listing. The
// generated scripts stamp their own runs in the same format.
export function dateStamp(date) {
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad);
  return `${day.join('-')}_${time.join('-')}`;
}

// chrome.downloads refuses a path with a character Windows can't store, such as
// the colon in localhost:8080, or a name that starts or ends with a dot.
export function recordingFolder(date, host = '') {
  const site = host.replace(/[^a-z0-9.-]+/gi, '-').replace(/^[.-]+|[.-]+$/g, '');
  return `api_toolbar/${[dateStamp(date), site].filter(Boolean).join('_')}`;
}

// One picture per step, named to match the step's response file.
export function stepScreens(plan) {
  return plan.steps
    .filter((step) => step.record.screen)
    .map((step) => ({ name: `screens/${step.file}.jpg`, screen: step.record.screen }));
}
