// Slack text rendering bound to the loaded people and channels, so mentions show real names and
// links to other Slack messages say which channel they point into.
import { slackToHtml, slackToPlainText } from "../utils/slackFormat.js";
import { nameOf } from "../utils/people.js";
import { store } from "../contexts/appState.js";

const NAME_RESOLVER = {
  personName: (id) => {
    const person = store.peopleById.get(id);
    return person ? nameOf(person) : null;
  },
  channelName: (id) => store.channels?.find((channel) => channel.id === id)?.name || null,
};

/** Slack text → HTML string with resolved names. Wrap in rawHtml() when interpolating. */
export function renderSlackText(text) {
  return slackToHtml(text, NAME_RESOLVER);
}

/** Slack text → one-line plain excerpt with resolved names. Escape it on output. */
export function slackExcerpt(text, maxLength) {
  return slackToPlainText(text, maxLength, NAME_RESOLVER);
}
