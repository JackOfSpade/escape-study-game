/**
 * Objective-specific development questions for product-engineering
 * foundations (PE T01-T06, T08-T10). Each entry is a small, self-contained
 * diagnostic: the prompt supplies its own artifact or evidence and asks one
 * main reasoning question. Code-change asks accept a description in words;
 * writing working code is optional.
 */
export const foundationQuestions: Record<
  string,
  { title: string; prompt: string; rubric: string[] }
> = {
  "PE:T01.1": {
    title: "Ambiguous request / restate the outcome",
    prompt: `A note-taking app's sales lead writes: "Big customers keep asking for an export button. Can we add one this sprint?" Facts you know: the app stores notes as rich text with embedded images; workspaces on the Business plan have up to 500 members; an admin said their legal team must keep a copy of all notes when an employee leaves.

Restate this request as (1) the user outcome in one sentence, naming who needs it, (2) two constraints that come from the facts above, (3) two assumptions you would need to confirm, and (4) one observable success condition. Keep "an export button" out of the outcome sentence itself.`,
    rubric: [
      "States a user outcome naming who benefits, without restating the button as the goal",
      "Lists constraints drawn from the supplied facts and separates them from assumptions",
      "Gives a success condition that could be observed or checked",
    ],
  },
  "PE:T01.2": {
    title: "Proposed solution / underlying problem",
    prompt: `In a team calendar app, a support manager proposes: "Add a red banner at the top of every page saying 'Check your time zone!'" Evidence: 40 tickets last month said meetings showed at the wrong time; 31 of those came from users who had traveled; the app reads the time zone once at sign-up and never updates it; no ticket mentions the banner idea.

Separate the underlying user problem from the proposed solution. Then list two assumptions behind the banner proposal and, for each, say what quick evidence would confirm or reject it. End with one alternative direction the evidence suggests.`,
    rubric: [
      "Describes the user problem independently of the banner",
      "Names assumptions embedded in the proposal and a concrete way to validate each",
      "Ties the alternative direction to the supplied evidence",
    ],
  },
  "PE:T01.3": {
    title: "Recurring expenses / MVP slice",
    prompt: `A personal budgeting app wants "recurring expenses". The full wish list: monthly and weekly schedules, custom intervals, editing one occurrence vs. all future ones, push reminders, automatic bank matching, and a forecast chart. The core outcome: a user who pays rent monthly should not have to re-enter it each month and should see it in that month's total.

Define the smallest MVP slice that still delivers the core outcome. List what is in it, at least three explicit non-goals from the wish list, and one reason the slice still serves the outcome. Name one non-goal that would be hardest to add later if you design the slice carelessly.`,
    rubric: [
      "Defines a small slice that still lets a monthly payment appear without re-entry",
      "Lists explicit non-goals taken from the wish list",
      "Identifies a deferred item with real later-change risk and explains why",
    ],
  },
  "PE:T01.4": {
    title: "Photo upload limits / compare scope options",
    prompt: `A listings site lets sellers upload photos. Sellers complain large phone photos fail. Two options:

Option A: raise the server upload limit from 5 MB to 25 MB. About 1 day of work; storage cost rises an estimated 3x; a config change that can be reverted in minutes.
Option B: resize images in the browser before upload to at most 2048 px. About 6 days of work; must handle HEIC photos from iPhones, which the current image library does not decode; once listings hold only resized images, the originals are gone.

Compare A and B on value to sellers, engineering cost, technical risk, and how easily each can be undone. Recommend one for the next two weeks and state what evidence would change your recommendation.`,
    rubric: [
      "Compares both options on all four named dimensions using the supplied facts",
      "Makes a recommendation consistent with the comparison",
      "Names evidence that would reverse the recommendation",
    ],
  },
  "PE:T01.5": {
    title: "Bulk archive / acceptance criteria",
    prompt: `A task manager adds a "bulk archive" action: a user selects tasks in a list and clicks Archive. Facts: only a task's assignee or a project admin may archive it; archiving 200 tasks takes up to 8 seconds; a confirm dialog appears before archiving; the list can be empty after filters.

Write acceptance criteria in Given/When/Then form covering the normal case, the empty case, a server error, a permission case where some selected tasks cannot be archived by this user, and cancelling at the confirm dialog. Each criterion must state an observable result.`,
    rubric: [
      "Covers normal, empty, error, permission, and cancellation states with one criterion each",
      "Makes each criterion's result observable rather than vague",
      "Handles the partial-permission selection explicitly",
    ],
  },
  "PE:T02.1": {
    title: "Saved searches / outcome and guardrail metrics",
    prompt: `A job board launches "saved searches": a signed-in user saves a search and gets a daily email when new matching jobs appear. The goal is that job seekers find relevant jobs with less effort. Available data: searches run, jobs viewed, applications submitted, emails sent, email unsubscribes, and page load times, each with a user ID and timestamp.

Define one outcome metric in operational terms: numerator, denominator, population, and time window. Then define two guardrail metrics that would reveal harm the feature could cause, and say what change in each would make you pause the rollout.`,
    rubric: [
      "Defines the outcome metric with numerator, denominator, population, and window",
      "Chooses guardrails tied to plausible harms of this feature",
      "States a pause threshold or direction for each guardrail",
    ],
  },
  "PE:T02.2": {
    title: "Checkout coupon / instrumentation schema",
    prompt: `An online store adds a coupon field at checkout. The metric to measure: "share of checkout sessions where a valid coupon was applied and the order was then placed, per day". Orders are confirmed by the server after payment; the browser may close before the confirmation page loads. A user can try several codes in one session.

Produce an event schema: event names, when each fires (browser or server, and at what moment), and the properties with identifiers needed to compute the metric exactly. Explain which identifier joins the coupon event to the order and why counting placed orders from a browser confirmation page would distort the metric.`,
    rubric: [
      "Lists events with firing location and timing that match the metric",
      "Includes a session or checkout identifier that joins coupon application to the order",
      "Explains the distortion from browser-side confirmation counting",
    ],
  },
  "PE:T02.3": {
    title: "Onboarding telemetry / critique",
    prompt: `A fitness app measures onboarding completion as "users who sent onboarding_finished divided by users who sent onboarding_started". The current telemetry:

- onboarding_started fires each time the welcome screen renders, including after app restarts.
- onboarding_finished fires on the last screen, keyed by device_id; users who sign in on a second phone get a new device_id.
- step_skipped includes the property free_text_goal, the user's typed health goal.
- Users who uninstall mid-onboarding are excluded from the weekly report.

Identify the defect in each bullet, name its category (duplicated or missing events, ambiguous identity, a privacy problem, or survivorship bias), and say whether and how it affects the completion rate; if a defect does not bias the rate, say so and name the other risk it creates instead. Propose one fix for the most damaging defect.`,
    rubric: [
      "Identifies a concrete defect in each of the four bullets with a fitting category",
      "Explains whether and in which direction each defect biases the completion rate, accepting that the free_text_goal privacy problem need not bias the metric when its separate risk is named",
      "Prioritizes one defect and gives a workable fix",
    ],
  },
  "PE:T02.4": {
    title: "Shorter signup form / experiment design",
    prompt: `A SaaS product wants to test removing the "Company size" and "Phone" fields from its 6-field signup form. Sales uses those fields to prioritize leads. Traffic: about 3,000 signup page visitors per day. Some people visit on both phone and laptop before signing up; visitors are anonymous until signup.

Specify a basic online experiment: the hypothesis, the randomization unit and how it is kept stable, the treatment and control, the primary metric, one guardrail metric, and two major validity risks with a mitigation for each.`,
    rubric: [
      "States a testable hypothesis and clear treatment versus control",
      "Chooses a randomization unit and addresses cross-device or anonymous identity stability",
      "Names a primary metric, a guardrail reflecting the sales concern, and two validity risks with mitigations",
    ],
  },
  "PE:T02.5": {
    title: "Recommendation widget / interpret results",
    prompt: `Experiment summary for a "You may also like" widget on product pages (14 days, randomized by user):

- Control: 52,140 users, purchase conversion 3.10%.
- Treatment: 51,980 users, purchase conversion 3.18%. Difference +0.08 percentage points, 95% CI -0.13 to +0.29.
- Treatment users clicked 2.4x more product links.
- Average order value: control $41.20, treatment $40.10; no interval reported.
- Separately, users who clicked the widget converted at 6.9%.

Write a conservative interpretation: what is causal evidence here, what is only association, whether the conversion change is practically meaningful, and what remains uncertain. Should the team ship? Justify briefly.`,
    rubric: [
      "Distinguishes the randomized comparison from the self-selected clicker conversion",
      "Interprets the confidence interval and practical significance without overclaiming",
      "Names unresolved uncertainty and makes a ship decision consistent with it",
    ],
  },
  "PE:T03.1": {
    title: "Comment mentions / vertical slices",
    prompt: `A document editor will add @mentions in comments: typing "@" shows a member picker, the mentioned person gets an in-app notification, and clicking it opens the comment. A teammate drafted this plan:

1. Database: mentions table.
2. API: all mention endpoints.
3. Frontend: picker, rendering, notification panel.
4. Testing.

Rewrite the plan as three or four vertical slices, each delivering a thin end-to-end behavior that can be demonstrated and verified on its own. For each slice, state how you would verify it is done. Explain one concrete problem the layer-by-layer plan would hide until late.`,
    rubric: [
      "Produces slices that each cross the needed layers and deliver a demonstrable behavior",
      "Gives an independent verification for each slice",
      "Explains a specific risk the layer-only plan defers",
    ],
  },
  "PE:T03.2": {
    title: "Address autocomplete / estimate risks",
    prompt: `You are asked to estimate adding address autocomplete to a checkout form. Known facts: the team has never used the chosen maps vendor's API; the vendor's pricing is per request and finance has not approved a budget; checkout must work in Canada and Mexico, and nobody has checked vendor coverage there; the checkout form is a legacy component with no tests.

List the dependencies and unknowns that could invalidate an estimate. For the two riskiest, describe a small time-boxed piece of risk-reduction work and what result would change the plan.`,
    rubric: [
      "Separates external dependencies from technical or product unknowns using the supplied facts",
      "Ranks risks and justifies which two are riskiest",
      "Proposes time-boxed risk-reduction work with a decision-changing outcome",
    ],
  },
  "PE:T03.3": {
    title: "CSV import / bounded estimate",
    prompt: `Feature: import contacts from a CSV file into a CRM. Scope agreed: upload a file up to 10,000 rows, map columns to name/email/phone, show a preview of the first 20 rows, and report rows that failed validation. Facts: the team built a similar Excel import last year in about 8 working days; this CRM has a stricter duplicate-email rule that nobody has implemented before; one engineer is available full-time.

Give a bounded estimate as a range (or relative sizing against the Excel import), list the assumptions it depends on, and state which uncertainty most widens the range. Say what you would report if, after two days, the duplicate rule turns out to need a schema change.`,
    rubric: [
      "Gives a range or relative size anchored to the supplied reference work",
      "States explicit assumptions and the main source of uncertainty",
      "Describes how the estimate would be updated and communicated after the new finding",
    ],
  },
  "PE:T03.4": {
    title: "Draft autosave / short technical proposal",
    prompt: `Users of a blog editor lose drafts when their browser crashes. Facts: drafts are saved only when "Save" is clicked; the API has PUT /posts/:id; average draft is 15 KB; some users edit the same post in two tabs.

Write a concise technical proposal (about 150-250 words) with these headings: Problem, Chosen approach, Alternatives considered (at least one, with why rejected), Contract (the request the client sends and how conflicts between tabs are detected), Risks, Rollout. Keep it to decisions a reviewer would need.`,
    rubric: [
      "Includes all six headings with content specific to the autosave problem",
      "Defines a contract that addresses the two-tab conflict",
      "Explains a rejected alternative and a staged rollout",
    ],
  },
  "PE:T03.5": {
    title: "Changed plan / communicate new evidence",
    prompt: `Two weeks ago you told stakeholders that offline mode for a field-inspection app would ship in six weeks, supporting viewing and editing inspections offline. New evidence: a spike showed that merging offline edits made by two inspectors on the same inspection causes data loss in 1 of 8 test scenarios; most inspections (about 90%) have a single inspector. You now propose shipping offline viewing plus offline editing only for single-inspector inspections in six weeks, and multi-inspector editing later with no date yet.

Write the update message (under 150 words) to stakeholders. It must state the new evidence, the trade-off, the revised scope, and what remains uncertain.`,
    rubric: [
      "States the new evidence plainly and links it to the decision change",
      "Describes the trade-off and the revised scope including what is deferred",
      "Is honest about remaining uncertainty rather than giving a false date",
    ],
  },
  "PE:T04.1": {
    title: "Recipe page navigation / loading trace",
    prompt: `A user clicks a link to https://recipes.example/pasta for the first time. Setup facts (already done; not part of the question): the DNS lookup and the HTTPS connection to recipes.example are complete, and the server returns this HTML in 300 ms:

\`\`\`html
<head>
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js"></script>
</head>
<body>
  <h1>Pasta</h1>
  <img src="/hero.jpg">
  <div id="steps"></div>
</body>
\`\`\`

app.js (120 KB) runs when the synchronous script loads and registers a DOMContentLoaded callback. That callback waits until the DOM is ready (DOMContentLoaded), then fetches /api/steps and inserts the returned steps into #steps; the callback never accesses #steps before it exists. Assume no caching and no service worker.

Answer two things:
1. Explain how /app.css and the synchronous /app.js in the head affect when the "Pasta" heading can first appear on screen, and name one change to this HTML that would let the heading appear sooner, with the reason.
2. Put these events in order and say briefly why: the /api/steps response arrives, app.js finishes downloading and runs, the steps appear in #steps.`,
    rubric: [
      "Explains how the stylesheet and the synchronous head script each delay the heading's first appearance",
      "Justifies one HTML change that lets the heading appear sooner",
      "Orders app.js running, the /api/steps response and the steps appearing in #steps, with a reason",
    ],
  },
  "PE:T04.2": {
    title: "Nested click handlers / event trace",
    prompt: `Given this markup and script:

\`\`\`html
<form id="f" action="/search">
  <div id="card">
    <a id="link" href="/item/7">Item 7</a>
    <button id="save">Save</button>
  </div>
</form>
\`\`\`

\`\`\`js
card.addEventListener("click", (e) => log("card " + e.target.id));
link.addEventListener("click", (e) => { e.preventDefault(); log("link"); });
save.addEventListener("click", (e) => { e.stopPropagation(); log("save"); });
f.addEventListener("submit", () => log("submit"));
\`\`\`

A button inside a form has type "submit" by default. Predict the full log output and any navigation or form submission when the user (1) clicks the link, and (2) clicks Save. Explain which call causes each difference.`,
    rubric: [
      "Predicts the exact log lines, their order, and whether navigation occurs for the link click",
      "Predicts the exact log lines and whether the form submits for the Save click",
      "Attributes each difference to the specific handler call or default behavior that causes it",
    ],
  },
  "PE:T04.3": {
    title: "Profile fetch / status and cancellation",
    prompt: `Consider this code:

\`\`\`js
async function loadProfile(id, signal) {
  try {
    const res = await fetch("/api/users/" + id, { signal });
    const data = await res.json();
    showProfile(data);
  } catch (err) {
    showError("Network problem");
  }
}
\`\`\`

Semantics: fetch resolves for any HTTP status, including 404 and 500, and rejects only on network failure or abort; aborting rejects with an error named "AbortError". The server returns 404 with body {"error":"not found"} for unknown users.

Trace what the user sees for (1) a 404, (2) a 500 whose body is an HTML error page, and (3) the request being aborted because the user navigated to another profile. Then describe how you would change the code so each case shows an appropriate state.`,
    rubric: [
      "Traces the user-visible result of the 404 using the stated fetch semantics",
      "Traces the 500 with an HTML body through each line of the code to what the user sees",
      "Traces the abort case and proposes changes giving each of the three cases an appropriate state",
    ],
  },
  "PE:T04.4": {
    title: "Blocking filter / task scheduling",
    prompt: `A product table has a filter box:

\`\`\`js
input.addEventListener("input", () => {
  spinner.hidden = false;
  const rows = filterAndSort(allRows, input.value); // ~900 ms synchronous
  render(rows);
  spinner.hidden = true;
});
\`\`\`

The browser runs one task at a time on the main thread and only paints between tasks. Users report that typed characters appear late and the spinner never shows.

Explain both symptoms using the task and rendering model. Then predict whether wrapping the filterAndSort and render calls in setTimeout(..., 0) makes the spinner appear and whether typing becomes responsive during the 900 ms. Propose one approach that actually keeps typing responsive.`,
    rubric: [
      "Explains the late characters using the one-task-at-a-time main thread model",
      "Explains the missing spinner using when the browser paints",
      "Predicts both effects of the setTimeout change and proposes an approach that keeps typing responsive",
    ],
  },
  "PE:T04.5": {
    title: "Clickable divs / native semantics",
    prompt: `A settings page contains:

\`\`\`html
<div class="nav" onclick="router.go('/billing')">Billing</div>
<div class="btn" onclick="saveSettings()">Save</div>
<div onclick="location.hash = '#tab=' + next">Next tab</div>
const prefs = JSON.parse(document.cookie.split("prefs=")[1]); // theme only, never sent to the server
\`\`\`

For each line, choose the native platform element or API you would use instead (link, button, form behavior, history/navigation, or storage) and give one concrete behavior the user or browser gets from the native choice that the current code lacks. Name one case where you would still add framework routing code on top.`,
    rubric: [
      "Chooses a fitting native element or API for each of the four lines",
      "Names a concrete behavior gained from each native choice that the current line lacks",
      "Identifies a justified case for framework routing on top of native semantics",
    ],
  },
  "PE:T05.1": {
    title: "Order screen / component boundaries",
    prompt: `An order-tracking screen was split by visual position:

\`\`\`text
<TopHalf>   order number, status badge, "Cancel order" button
<BottomHalf> item list, "Cancel order" confirmation dialog, delivery map
\`\`\`

Behavior facts: cancelling is allowed only while status is "placed"; after a successful cancel the status badge and the item list both change; the delivery map polls a courier location API every 10 s and nothing else uses that data; the item list's sort choice affects only the list.

Propose a component breakdown whose boundaries follow behavior and data ownership. For each component, say what data or state it owns and what it receives as props. Explain where cancel state and the courier polling should live and why the TopHalf/BottomHalf split makes the cancel flow awkward.`,
    rubric: [
      "Proposes components grouped by responsibility rather than screen position",
      "States owned state versus received props for each component",
      "Justifies where cancel state and courier polling live using the behavior facts",
    ],
  },
  "PE:T05.2": {
    title: "Cart component / redundant state",
    prompt: `\`\`\`jsx
function Cart({ items }) {
  const [count, setCount] = useState(items.length);
  const [total, setTotal] = useState(sum(items));
  const [coupon, setCoupon] = useState("");
  const [discounted, setDiscounted] = useState(sum(items));
  useEffect(() => { setCount(items.length); setTotal(sum(items)); }, [items]);
  function applyCoupon(code) { setCoupon(code); setDiscounted(applyCode(total, code)); }
  // renders count, total, discounted, and a coupon input
}
\`\`\`

Semantics: useState keeps its value across renders and ignores later changes to its initial argument; effects run after the render is painted. sum(items) returns the total of item prices; applyCode(total, code) returns the discounted total; both are pure and neither mutates its inputs.

Identify which values are source-of-truth state and which are derived. Describe a bug a user could see when items change after a coupon was applied, and what the screen shows for one render after items change. Then describe in words (or show, if you prefer) how you would change the component's state so no derived value is stored; writing working code is not required.`,
    rubric: [
      "Classifies each of the four values as source of truth or derived with reasons",
      "Describes a concrete stale-display bug and the intermediate render",
      "Describes or shows a change that keeps only source-of-truth state and computes derived values during render",
    ],
  },
  "PE:T05.3": {
    title: "Filter panel / controlled data flow",
    prompt: `A product list has a sidebar with a "Price under" input and an "In stock only" checkbox. Today the sidebar reads them with refs only when the user clicks Apply:

\`\`\`jsx
function Sidebar({ onApply }) {
  const priceRef = useRef(); const stockRef = useRef();
  return (<>
    <input ref={priceRef} type="number" />
    <input ref={stockRef} type="checkbox" />
    <button onClick={() => onApply(priceRef.current.value, stockRef.current.checked)}>Apply</button>
  </>);
}
\`\`\`

New requirements: a "Clear filters" button in the page header must reset both controls, and the list must update as the user types (no Apply button).

Decide which component owns the filter state and describe in words (or sketch in code, optional) the controlled version: the owner's state, the props passed to Sidebar, and the event handlers. Explain how the header's Clear button updates both the controls and the list.`,
    rubric: [
      "Places filter state in a common owner of the sidebar, header, and list",
      "Describes or shows inputs controlled with value or checked plus change handlers",
      "Shows the data flow by which Clear resets both the controls and the list",
    ],
  },
  "PE:T05.4": {
    title: "Chat room component / effects and cleanup",
    prompt: `\`\`\`jsx
function ChatRoom({ roomId, draft }) {
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);
  useEffect(() => { setUnread(messages.filter((m) => !m.read).length); }, [messages]);
  useEffect(() => {
    const conn = chat.connect(roomId);
    conn.on("message", (m) => setMessages((ms) => [...ms, m]));
  }, [roomId]);
  useEffect(() => { if (draft.sent) analytics.track("message_sent"); }, [draft]);
}
\`\`\`

Semantics: chat.connect opens a socket that stays open until conn.close() is called. An effect's returned function runs before the effect re-runs and on unmount.

For each effect, decide whether it is really a value computed during render, logic that belongs to a user event, or synchronization with an outside system. Predict what happens after the user switches from room 1 to room 2 and back. Then describe in words (or show in code, optional) where each part should move, including cleanup where needed.`,
    rubric: [
      "Classifies the three effects into the three categories with reasons",
      "Predicts the connection and message behavior after switching rooms using the stated semantics",
      "Describes or shows each part moved to the place matching its classification, with cleanup where synchronization needs it",
    ],
  },
  "PE:T05.5": {
    title: "Profile editor / state identity",
    prompt: `\`\`\`jsx
function Page({ selectedUser }) {
  return (
    <div>
      {isAdmin ? <AdminBanner /> : null}
      <ProfileForm user={selectedUser} />
    </div>
  );
}
function ProfileForm({ user }) {
  const [name, setName] = useState(user.name);
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}
\`\`\`

Semantics: React preserves a component's state while the same component type stays at the same position in the tree; changing its key creates a fresh instance. A null child still occupies its position.

Predict the input's value when an admin has typed "Ann B" for user Ann and then selects user Bo. Predict whether toggling isAdmin resets the form. Then describe in words (or show, optional) a change that makes the form reset when the selected user changes, and explain why your choice is better than syncing name in an effect.`,
    rubric: [
      "Predicts the input value after switching users and justifies it with the stated identity rule",
      "Predicts the effect of toggling the banner using the position rule",
      "Describes or shows a per-user form reset and compares that approach with effect-based syncing",
    ],
  },
  "PE:T06.1": {
    title: "Username signup / client and server validation",
    prompt: `A signup form has a username field. Rules: 3-20 characters, letters, digits, and underscores only, and not already taken. The browser can check length and characters instantly. Only the server knows which usernames are taken; two people can submit the same name within the same second. The form currently disables Submit until the client-side checks pass and treats a passing client check as "username OK".

Model the form's state: which values you store for the field, which validation results you keep and where each comes from, and the submission states. Explain why "client check passed" cannot mean "username accepted", and what the form shows when the server rejects a name the client allowed.`,
    rubric: [
      "Models field value, client check results, server result, and submission status as distinct state",
      "Explains why client checks are convenience only and the server decision is authoritative",
      "Describes the user-visible handling of a server rejection after a client pass",
    ],
  },
  "PE:T06.2": {
    title: "Payment button / submit, pending, retry",
    prompt: `A donation form posts {amount, cardToken} to POST /donations. The request can take up to 6 seconds. Users sometimes double-click Donate, and on slow networks some reload the page. The server accepts an optional Idempotency-Key header: repeated requests with the same key return the first result instead of charging again. On timeout the client cannot tell whether the charge happened.

Specify the form's behavior from the moment Donate is pressed: while waiting, after success, after an error, and when the user tries again. Say what the button and fields show in each state, how you prevent a duplicate charge from double-clicks and from retrying after a timeout, and which user input you keep after an error.`,
    rubric: [
      "Specifies visible behavior for each of the five states",
      "Prevents duplicates from double-clicks and from retry after an uncertain timeout",
      "States which input is preserved after an error and why",
    ],
  },
  "PE:T06.3": {
    title: "Issue tracker list / route and query state",
    prompt: `An issue tracker page shows issues for one project. The user can filter by status (open, closed), assign a label filter, sort by newest or most commented, open an issue in a side panel, and type an unsent comment in that panel. Today everything is stored in component state and the URL is always /issues. Users complain that sharing a link or pressing Back loses their view.

Decide which pieces of state belong in the path, which in query parameters, and which should stay out of the URL. Write the URL for "project web-app, closed issues labelled bug, most commented, issue 482 open in the panel". Say what Back should do after opening the panel, and how the page should treat a URL with an unknown sort value.`,
    rubric: [
      "Assigns each piece of state to path, query, or non-URL state with reasons",
      "Writes a concrete URL that encodes the requested view",
      "Describes Back behavior and handling of an invalid query value",
    ],
  },
  "PE:T06.4": {
    title: "City weather / stale responses",
    prompt: `\`\`\`jsx
function Weather({ city }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch("/api/weather?city=" + city)
      .then((r) => r.json())
      .then((d) => setData(d));
  }, [city]);
  return <p>{data ? data.city + ": " + data.temp : "Loading"}</p>;
}
\`\`\`

Semantics: the effect re-runs when city changes, and the function an effect returns runs before the next run. Responses can arrive in any order.

The user selects Oslo, then quickly Rome. The Rome response arrives first, then Oslo's. Trace what the paragraph shows over time. Then describe in words (or show in code, optional) a change so a stale response cannot overwrite the current city, and say what it shows while Rome is loading.`,
    rubric: [
      "Traces the displayed text across both responses in the stated order",
      "Describes or shows cleanup that ignores or aborts the outdated request",
      "Defines a loading display that does not present the previous city's data as current",
    ],
  },
  "PE:T06.5": {
    title: "Shipping form / failed validation experience",
    prompt: `A shipping form has fields Name, Street, Postcode, and Phone. Current behavior on submit with errors: all invalid fields get a red border; one message at the top says "Please fix the errors"; focus stays on the Submit button; the fields use placeholder text instead of labels, which disappears when typing; Postcode and Phone errors are shown only by color.

A keyboard-only user submits with an invalid Postcode and an empty Phone. Describe what they currently experience. Then specify the repaired flow: labels, per-field error text and how it is associated with each field, where focus goes after a failed submit, and how a screen-reader user learns how many errors exist and what to fix.`,
    rubric: [
      "Describes the current experience for the keyboard user concretely",
      "Specifies visible labels and per-field error text programmatically tied to the inputs",
      "Specifies focus movement and an error summary that is announced and navigable",
    ],
  },
  "PE:T08.1": {
    title: "Toolbar markup / semantic controls",
    prompt: `A photo editor's toolbar is built like this:

\`\`\`html
<div class="icon" onclick="undo()"><svg>...</svg></div>
<span class="toggle on" onclick="toggleGrid()">Grid</span>
<div class="dropdown" onclick="openMenu()">Export ▾</div>
<input type="range" min="0" max="100"> <span>Brightness</span>
\`\`\`

Each control works with a mouse. The undo icon has no text. The Grid toggle has an on/off state shown only by the "on" class.

For each control, choose the native HTML element you would use, how it gets an accessible name, and how its state or relationship (for example to its visible label or to the menu it opens) is exposed. Say where, if anywhere, you would still need an ARIA attribute and why native HTML does not cover it.`,
    rubric: [
      "Chooses an appropriate native element for each of the four controls",
      "Gives each control an accessible name and associates the slider with its visible label",
      "Exposes toggle state and menu relationship, using ARIA only where native HTML falls short",
    ],
  },
  "PE:T08.2": {
    title: "Cookie dialog / focus trace",
    prompt: `A page loads with this order in the DOM:

1. \`<a href="/">Logo</a>\`
2. \`<div class="menu-btn" onclick="openNav()">Menu</div>\`
3. \`<input id="search">\`
4. A cookie dialog (shown on load, visually on top) containing: \`<p>text</p>\`, \`<button>Accept</button>\`, \`<button>Settings</button>\`
5. Footer links

CSS includes \`*:focus { outline: none; }\`. The dialog has no focus management; when Accept is clicked, the dialog is removed from the DOM.

Trace each Tab press for a keyboard user starting from page load until they reach Accept, and say what they see while tabbing. Then trace where focus goes after pressing Enter on Accept. List the repairs needed for an unreachable control, missing visible focus, and dialog focus behavior.`,
    rubric: [
      "Traces the Tab order through the listed elements, noting what is skipped and what is invisible",
      "Predicts where focus lands after the dialog is removed",
      "Repairs reachability, visible focus, and focus handling into and out of the dialog",
    ],
  },
  "PE:T08.3": {
    title: "Pricing cards / responsive layout",
    prompt: `\`\`\`css
.plans { display: flex; }
.plan { flex: 0 0 380px; margin-right: 24px; }
.plan h3 { white-space: nowrap; }
@media (max-width: 375px) {
  .plans { flex-direction: column; }
  .plan { flex-basis: auto; width: 100%; }
}
\`\`\`

Note: flex: 0 0 380px means each card neither grows nor shrinks from a 380 px basis.

The page shows three pricing cards. Screenshots: at 1280 px wide the cards fit. At 800 px wide the third card is cut off and the page scrolls horizontally. At 390 px wide (a common phone) the layout is the same as at 800 px. At 320 px wide the cards stack correctly but long plan names in German overflow their card.

Explain why each of the three narrow-width problems happens from this CSS. Then describe in words (or show CSS, optional) how you would change the rules so the cards reflow at any width without targeting specific devices, and explain how your version handles a fourth card being added later.`,
    rubric: [
      "Explains each narrow-width problem using the supplied CSS, including the fixed non-shrinking basis, the 375 px query missing a 390 px screen, and nowrap on long names",
      "Describes or shows a layout that reflows based on available space rather than device breakpoints",
      "Handles long text and an added card without new special cases",
    ],
  },
  "PE:T08.4": {
    title: "Order summary / locale formatting",
    prompt: `\`\`\`js
const line = "Ordered " + qty + " item" + (qty === 1 ? "" : "s") +
  " on " + (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear() +
  " for $" + total.toFixed(2);
button.style.width = "80px"; // label "Buy again"
\`\`\`

The app will launch in German (de-DE, prices in EUR), Polish (pl-PL, PLN), and Arabic (ar-EG, EGP). Facts: Polish has more than two plural forms; the German label for "Buy again" is "Erneut kaufen"; Arabic is right-to-left.

List each locale assumption in this code and the visible defect it causes in one of the three locales. Then describe in words (or show in code, optional) how you would rebuild the line using Intl.DateTimeFormat, Intl.NumberFormat with currency, and Intl.PluralRules or a message format, and how you would address the button and text-direction issues.`,
    rubric: [
      "Identifies each locale assumption in the code and a concrete visible defect in one of the three locales",
      "Describes or shows the line rebuilt with the named Intl APIs using the user's locale and currency",
      "Describes changes that address the button sizing and text-direction issues",
    ],
  },
  "PE:T08.5": {
    title: "Notification bell / prioritized review",
    prompt: `Review this notification popover component:

\`\`\`html
<div class="bell" onclick="toggle()"><img src="bell.svg"></div>
<div class="popover" style="position:absolute; width:420px; left:-300px">
  <div class="item">{name} commented on {doc} · {timeAgoEnglish}</div>
  ...
</div>
\`\`\`

Facts: the popover opens only on mouse click; Escape does nothing; on a 360 px phone the popover extends off the left edge of the screen; "timeAgoEnglish" returns strings like "3 mins ago"; the unread count is shown as a red dot only; the bell image has no alt text; the item font is 13 px gray (#999) on white, contrast 2.8:1.

List the concrete defects in accessibility, responsiveness, and localization readiness. Prioritize the top three to fix first, justify the order by user impact, and propose a concrete repair for each of those three defects.`,
    rubric: [
      "Lists concrete defects across all three categories from the supplied facts",
      "Prioritizes three defects with a justification based on who is blocked and how badly",
      "Proposes a specific fix for each prioritized defect",
    ],
  },
  "PE:T09.1": {
    title: "Three slow reports / classify bottlenecks",
    prompt: `For each report, decide which cause dominates: bytes over the network, main-thread rendering or scripting, requests chained one after another, or work that did not need to happen at all. Cite the evidence that decides it.

Report A, dashboard first load: waterfall shows GET /me (220 ms), then GET /teams starting after /me finishes (240 ms), then GET /stats starting after /teams finishes (260 ms). Each request only needs the session cookie. CPU is idle between them.

Report B, article page on 3G: the hero image is 2.4 MB and finishes at 7.8 s; scripting totals 180 ms.

Report C, typing in a notes app: each keystroke triggers a 140 ms task. The profile shows the whole 2,000-note sidebar re-rendering although only the open note's text changed.

For one report, name the measurement you would take next to confirm your classification.`,
    rubric: [
      "Assigns a category to each report using the decisive evidence",
      "Distinguishes sequencing delay from raw network cost and from main-thread work",
      "Names a confirming measurement for one report",
    ],
  },
  "PE:T09.2": {
    title: "Field metrics / what LCP, INP, CLS show",
    prompt: `A recipe site's field data (75th percentile, mobile) after a redesign:

- LCP: 2.1 s (was 3.4 s). The LCP element is now the page title text; previously it was the hero photo, which now loads after the title.
- INP: 480 ms (was 190 ms). The worst interactions are taps on the "Ingredients" tab.
- CLS: 0.02 (was 0.02). Users complain that the "Jump to recipe" button moves when ads load after they scroll.

The team says, "LCP improved, so the page loads faster." For each metric, explain what it measures, what this data does and does not tell you about user experience, and whether the team's claim is supported. Explain how the complaint can coexist with a low CLS value.`,
    rubric: [
      "Explains what each of LCP, INP, and CLS measures",
      "Evaluates the team's claim given the changed LCP element",
      "Explains the limits of the CLS value relative to the reported complaint and flags the INP regression",
    ],
  },
  "PE:T09.3": {
    title: "Admin page / loading tactic",
    prompt: `A web app's main bundle is 1.1 MB of JavaScript. Bundle analysis: 620 KB is a charting library used only on the /reports page, which 8% of sessions visit; 90 KB is the editor used on every page. Separately, the home page's LCP element is a hero image discovered late because it is set as a CSS background in a stylesheet loaded at the end of the body. From the home page, 60% of users next click "Projects".

For each of three bottlenecks (the charting code, the late hero image, the Projects navigation), choose one tactic (for example splitting code into a separate chunk, deferring a load until needed, fetching ahead of the next navigation, or raising a resource's fetch priority), and explain why it fits that bottleneck. Name one tactic that would be a poor fit for the hero image and why.`,
    rubric: [
      "Chooses a fitting tactic for each of the three bottlenecks with reasoning",
      "Justifies choices with the supplied usage and discovery facts",
      "Explains why a named tactic would harm or not help the hero image",
    ],
  },
  "PE:T09.4": {
    title: "Contacts table / avoidable work",
    prompt: `\`\`\`jsx
function Contacts({ contacts, query }) {
  const [selectedId, setSelectedId] = useState(null);
  const sorted = [...contacts].sort(byLastName); // 5,000 contacts
  const visible = sorted.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  return visible.map((c) => (
    <Row key={Math.random()} contact={c}
         selected={c.id === selectedId}
         onSelect={() => setSelectedId(c.id)} />
  ));
}
\`\`\`

Profile: clicking a row takes 320 ms; every Row remounts and re-renders, and the sort takes 40 ms on each click. A teammate proposes wrapping Row in React.memo and every function in useCallback.

Identify the avoidable work on a row click and its causes. Propose the simplest fixes in order, and explain whether the teammate's memo proposal would help before your fixes are applied.`,
    rubric: [
      "Identifies the avoidable remounting and repeated computation and their causes",
      "Proposes simple fixes ordered by impact before memoization",
      "Evaluates the memo proposal against the current code",
    ],
  },
  "PE:T09.5": {
    title: "Rich previews / measurement plan",
    prompt: `A chat app will add link previews: when a message contains a URL, the client fetches preview metadata and renders a card with an image. Current baselines: chat-open LCP p75 1.9 s, message-send INP p75 120 ms, and an average of 1.4 MB transferred per chat session. Previews will roll out behind a flag to 10% of users first.

Plan how you will measure the change: which metrics you compare, which populations and time windows, and how you avoid mistaking a weekday-weekend or release difference for the feature's effect. Then define one performance guardrail with a concrete threshold and the action taken if it is breached.`,
    rubric: [
      "Selects metrics tied to the ways previews could slow the experience",
      "Uses the flag to compare concurrent populations and controls confounders",
      "Sets a concrete guardrail threshold with a defined response",
    ],
  },
  "PE:T10.1": {
    title: "Event check-in / resource boundaries",
    prompt: `A conference app's check-in screen has three tabs (Upcoming, Checked in, No-shows). Staff tap a badge card to check an attendee in, can undo within 5 minutes, and can add a walk-in attendee. A draft API mirrors the screen:

\`\`\`text
GET /checkinScreen/tab1
GET /checkinScreen/tab2
POST /checkinScreen/tapCard?row=14
POST /checkinScreen/undoButton
\`\`\`

Explain two problems with these contracts. Propose resource or action boundaries and stable identifiers for events, attendees, and check-ins that support the workflow, including how undo is expressed and how the three tabs are fetched. Say which identifier the client must send to check someone in.`,
    rubric: [
      "Explains concrete problems caused by tying contracts to UI structure",
      "Proposes resources or actions with stable identifiers that cover check-in, undo, and walk-ins",
      "Shows how the tabs are expressed without dedicated per-tab endpoints",
    ],
  },
  "PE:T10.2": {
    title: "Seat reservation / response and error semantics",
    prompt: `POST /shows/:showId/reservations with body {"seatIds": ["A1","A2"]} reserves seats for 10 minutes. Situations the client must handle: success; one seat already taken by someone else; the body has an unknown seat ID; the user's session expired; the user already holds the maximum of 6 seats; the same request was retried after a timeout; a server bug.

Specify the HTTP status and response body for each situation so the client can choose a distinct action (retry, re-select seats, sign in again, show a field error, or show a generic failure). Include in the error body what tells the client which seats were taken, and explain how the retried request avoids double-reserving.`,
    rubric: [
      "Gives a status and body for each listed situation",
      "Makes each outcome distinguishable and mapped to a client action",
      "Identifies taken seats in the error body and handles retries idempotently",
    ],
  },
  "PE:T10.3": {
    title: "Product catalog / reproducible result sets",
    prompt: `GET /products currently accepts ?page=3&sort=price&q=lamp&category=lighting. Problems reported: two products with the same price appear on both page 2 and page 3; new products added while browsing shift items between pages; "sort=price" does not say ascending or descending; some clients send q with different capitalization and get different results; filtering by two categories is impossible.

Specify the query semantics precisely: sort fields, direction and tie-breaker, pagination scheme and what the response returns to fetch the next page, filter syntax for multiple categories, and search matching rules. Show a request and response skeleton for the second page of lamps sorted by price high to low.`,
    rubric: [
      "Defines sorting with explicit direction and a deterministic tie-breaker",
      "Chooses a pagination scheme that stays stable under inserts and returns a next-page token or equivalent",
      "Defines multi-value filters and search matching, with a concrete request and response skeleton",
    ],
  },
  "PE:T10.4": {
    title: "Invoices / ownership and lifecycle",
    prompt: `An invoicing tool: a member creates an invoice, edits it, and sends it to a client. Requirements: unsent invoices can be deleted outright; sent invoices can never be edited, only voided, and must stay visible for accounting for 7 years; a sent invoice records the exact customer address used even if the customer's address later changes; invoices belong to a workspace, and a member who leaves the workspace must not keep access.

Model the lifecycle states and allowed transitions, which fields freeze at which state, and who owns the record. Explain how "deleted" differs for unsent and sent invoices, and how the API responds to an edit attempt on a sent invoice.`,
    rubric: [
      "Defines lifecycle states and allowed transitions consistent with the requirements",
      "Handles historical address snapshotting and workspace ownership",
      "Distinguishes deletion behavior by state and specifies the rejected edit response",
    ],
  },
  "PE:T10.5": {
    title: "Task assignee / compatible revision",
    prompt: `A task API returns {"id": "t1", "title": "...", "assignee": "u42"}. Mobile clients released last year read assignee as a single user ID string and cannot be force-updated; about 20% of users stay on old versions for months. New requirement: a task can have up to 5 assignees. Clients also send PATCH /tasks/t1 {"assignee": "u7"}.

Propose a revision of the response and request contract that supports multiple assignees without breaking old clients. Specify what old clients see for a task with three assignees, what happens when an old client PATCHes assignee on a multi-assignee task, and when the old field could be removed.`,
    rubric: [
      "Adds multi-assignee support without changing the meaning of the existing field for old clients",
      "Defines behavior for old-client reads and writes on multi-assignee tasks",
      "Gives a deprecation path with a measurable removal condition",
    ],
  },
};
