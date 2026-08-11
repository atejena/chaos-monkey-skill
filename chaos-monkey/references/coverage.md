# Coverage: Every Route, Every Button, Every Flow

Two different questions live here, and conflating them is why coverage work usually goes
badly.

**Reachability**: can a user get to every route, in every role, without hitting a 404 or a
dead end? This is answerable mechanically by a crawler, and it should be exhaustive.

**Correctness**: does the flow actually do the right thing? This needs written tests, and
it should be prioritized rather than exhaustive.

Do the crawl first. It is cheap, it finds the embarrassing bugs, and it tells you which
flows exist before you start writing tests for them.

---

## 1. Route inventory from source

Extract the complete route list from the framework rather than from the sitemap or the nav,
because the routes that are missing from the nav are exactly the ones that break.

- **Next.js app router**: every `page.tsx` under `app/`, with dynamic segments noted
- **Next.js pages router**: every file under `pages/`
- **React Router**: the route config object
- **API**: every `route.ts`, server action, and edge function

For each route, record the roles that should reach it and the roles that should not. Both
lists get tested. A route that renders for a role that should not see it is a bug of equal
weight to a route that 404s for a role that should.

## 2. The crawler

`scripts/crawler.spec.ts` implements this. It runs per role and does a breadth first walk
from the entry points.

At every page it asserts:

- HTTP status is 200 (or a deliberate 403/404 for routes on the deny list)
- No console errors and no unhandled rejections
- No visible error boundary, no raw stack trace, no "something went wrong" text
- The page has a heading and rendered content, not an empty shell
- Every anchor with an internal href resolves to a non 404 (HEAD request, deduped)
- Every `<img>` and background asset loads
- Query count and duration are within budget for that route

Then it enqueues every newly discovered internal link. The output is a coverage report:
routes visited, routes never reached from any entry point, and routes that were reachable
but should not have been for that role.

**Routes never reached by the crawler are the real finding.** They are either dead code or
they are only reachable from a state the crawler could not create, which usually means they
are also under tested by humans.

## 3. Where 404s actually come from

Ordered by how often they turn up in practice:

1. **Deep link plus refresh.** SPA routing handles the client transition, the server has no
   matching route, refresh gives a 404. Test by loading every route directly rather than by
   navigating to it. This is the single most common source.
2. **Trailing slash and case.** `/Projects` and `/projects/` versus `/projects`.
3. **Links to deleted or moved resources.** Delete a record, then load a page that still
   links to it. Also test: a bookmark to a record that was deleted, and an email link to a
   record whose project was archived.
4. **Role dependent routes rendered unconditionally.** The nav shows a link the current role
   cannot reach.
5. **Hardcoded paths that drifted** during a refactor. The crawler catches every one.
6. **Missing static assets** after a build. Icons, fonts, og images, favicon, manifest.
7. **Redirect chains and loops.** Especially around auth: unauthenticated user deep links,
   gets bounced to login, logs in, and lands on the dashboard instead of the page requested.
   That is not a 404 but it is the same class of broken.
8. **API 404s rendered as blank UI.** The page returns 200 while its data fetch 404s and the
   component renders nothing. Distinguishing a genuine empty state from a silently failed
   fetch requires checking the network, not the screen.

## 4. Dead buttons

A button that does nothing is invisible to normal testing because nothing fails.

The oracle: click it, then assert that **at least one** of these happened within 2 seconds.

- A network request fired
- The URL changed
- The DOM mutated in a meaningful way (a MutationObserver, excluding animation and hover)
- Focus moved
- A dialog, toast, or modal appeared

If none did, it is a dead control. `scripts/crawler.spec.ts` includes this check.

Also flag as suspicious:

- A button in a permanently disabled state with no explanation of why
- A form that submits and shows no confirmation of any kind
- A control that fires the same request twice per click
- A link with `href="#"` or an empty href
- A control with no accessible name (a screen reader reads it as "button")

## 5. Flow tests

From the inventory, list the flows that matter and write one test each. For a contractor
portal the set is roughly: sign up, invite a client, create a project, add selections,
client approves a selection, create a change order, client approves the change order,
upload a document, client views it, comment thread, notification delivery, invoice or
payment if present, archive a project, remove a user.

Each flow test is written as the happy path plus its named unhappy branches:

```
flow: client approves a change order
  happy:    invited client logs in, opens pending change order, approves, status becomes approved,
            contractor receives a notification, the project total updates by exactly the CO amount
  unhappy:  already approved by someone else
            approved after the contractor voided it
            session expired at the moment of approval
            network dies between click and confirmation
            two approvers click within the same second
            the underlying selection was deleted after the CO was created
```

Write the happy path first and get it green. The unhappy branches are where the bugs are,
but a flaky happy path makes every branch result meaningless.

## 6. What good coverage looks like

Do not chase a code coverage percentage. Track these instead, since they map to what
actually breaks:

- Percentage of routes visited by the crawler in each role
- Percentage of interactive controls that passed the dead button check
- Number of named flows with a passing test
- Number of unhappy branches per flow (a flow with a happy path and no branches is
  effectively untested)
- Routes with a query budget assertion
