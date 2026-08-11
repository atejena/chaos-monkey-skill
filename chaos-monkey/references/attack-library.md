# Attack Library

Read the sections that match the target inventory. Each attack lists what to do and what a failure looks like, because half of these bugs look like success on screen.

## Contents

1. Tenant isolation and authorization
2. State machines and workflow
3. Concurrency and races
4. Money, quantity, arithmetic
5. Text inputs
6. Numbers, dates, times
7. File upload
8. Network and failure injection
9. Session and auth lifecycle
10. Realtime, webhooks, background jobs
11. Navigation and browser behavior
12. Accessibility and viewport

---

## 1. Tenant isolation and authorization

The highest value section. Run it first and run it fully.

| Attack | Failure looks like |
|---|---|
| Log in as tenant A, capture every ID visible (project, document, file, user, invoice). Log in as tenant B, replay each ID against every endpoint via direct API call. | Anything other than 403 or 404. A 200 is critical. A 500 means the check happens after the query, which usually means the row was fetched. |
| Same replay, but on write endpoints (PATCH, DELETE) rather than read. | Row modified. Also check the DB directly, since the UI may lie. |
| Sequential and guessable IDs. If IDs are integers, request neighbours. If UUIDs, check whether they appear in any client bundle, error message, or public share link. | Enumeration possible. |
| Sub resource smuggling: valid parent ID from tenant B, valid child ID from tenant A, in the same request. | Nested authorization checked only on the parent. |
| Role escalation in the body: send `role: "owner"` or `tenant_id: <other>` on a self update endpoint. | Field mass assigned. |
| Access a page by direct URL that the nav hides for the current role. | Client only route guard. |
| Invited but not yet accepted user hitting resource endpoints. | Pending users treated as members. |
| Removed user replaying an old but unexpired token. | Revocation not enforced on the server. |
| Publicly shared link (if any) after the resource is unshared or the project is deleted. | Share tokens never invalidated. |
| Signed storage URLs: reuse after expiry, and swap the path segment to another tenant's object. | Storage policy weaker than the API policy. This is a very common Supabase gap. |

For row level security specifically, test with the anon key from a plain fetch, not through the app client. The app client may be applying filters that RLS itself is not.

## 2. State machines and workflow

Anything with a status column.

- Perform every transition out of order. Approve something already approved. Reject after approve. Submit a draft twice. Void then approve.
- Replay an old transition request after the state has moved on.
- Mutate a record that is in a locked state (approved, signed, invoiced). Try it through the API rather than the UI, since the UI usually disables the button and the API usually does not.
- Delete a parent while a child is mid transition. Delete a selection referenced by an approved change order. Delete a user who is the approver on a pending item.
- Transition a record whose prerequisite was deleted after the transition began.
- Two approvers approve the same item within the same second.
- Reach a terminal state, then attempt every possible transition out of it.

Failure looks like: a record in a state that is not in the diagram, a total that changed after lock, an audit trail with two approvals, a dangling foreign key, or a stuck item with no path forward.

## 3. Concurrency and races

- Open the same record in two tabs. Edit different fields in each. Save both. Second save should not silently discard the first tab's field.
- Same record, same field, two tabs, save both. Last write wins is acceptable only if it is deliberate; silent loss with no warning is a bug.
- Double click every submit button. Then triple click. Then click and press Enter simultaneously.
- Fire the same POST twice concurrently (same idempotency key if one exists, and again with none).
- Start an upload, then navigate away before it finishes.
- Submit a form, then immediately hit browser back and submit again.
- Two users mutate the same aggregate (add line items to the same estimate) simultaneously, then compare the total against the sum.
- Trigger a background job twice for the same entity.

Speed matters. Most of these only reproduce with throttling off and network fast, or with the harness firing requests directly rather than through the UI.

## 4. Money, quantity, arithmetic

- Negative quantity, negative price, negative discount. Then a discount larger than the subtotal.
- Zero quantity. Zero price. Both.
- Values that expose float math: 0.1 + 0.2, 1.005 rounded to 2dp, a 3 way split of $100.
- Very large: 999999999.99, then one digit more. Check for overflow, scientific notation in the UI, and DB numeric precision errors.
- Many small: 500 line items at $0.01. Sum must be exact.
- Percentages: 0%, 100%, 101%, negative, 33.333%.
- Change a unit price after a total was computed and stored. Do the stored total and the recomputed total agree?
- Currency input formats: `1,234.56`, `$1234.56`, `1.234,56`, `1234.5.6`, `1e3`, `--5`.
- Tax and markup applied twice by submitting the calculation endpoint twice.
- Rounding direction consistency between the line item view, the summary, and the PDF or invoice output. These three are usually computed in three different places, which is exactly why they disagree.

Failure looks like: any discrepancy between what the client shows, what the DB stores, and what the exported document says.

## 5. Text inputs

Payload strings are in `scripts/payloads.json`. For every text field, run: empty, whitespace only, one character, the max allowed length, max plus one, and 100x max.

Categories worth their own attention:

- **Unicode**: emoji, emoji with zero width joiners (family emoji), combining diacritics stacked (Zalgo), right to left override characters, invisible characters, CJK, Turkish dotless i (breaks `toLowerCase` comparisons), and characters outside the basic multilingual plane (breaks naive length limits and MySQL utf8).
- **Injection**: script tags, `javascript:` URLs, SQL quote breaking, `{{7*7}}` and `${7*7}` template injection, `../../etc/passwd`, null bytes, CRLF for header injection, formula prefixes (`=cmd|`, `+`, `-`, `@`) for CSV export cells.
- **Structural**: leading and trailing whitespace (is it trimmed consistently between create and search?), newlines in a single line field, tabs, HTML entities, a string that is already escaped HTML.
- **Semantic**: a name that is `null`, `undefined`, `NaN`, `true`, `0`, or `constructor` as a literal string. A search for a single space. An email like `a@b`, `a@@b.com`, `très@long.example`, or 320 characters.

Failure looks like: rendered markup, a 500, silent truncation without warning, text that changes between save and reload, a search that cannot find the record that was just created, or a broken CSV export.

## 6. Numbers, dates, times

- Numeric fields: `-0`, `0.0000001`, `1e308`, `Infinity`, `NaN`, leading zeros, thousands separators, hex `0x10`, a number as a string, an array.
- Dates: Feb 30, Feb 29 in a non leap year, the DST spring forward hour (2:30am on the change date), year 0001 and 9999, an end date before the start date, an end date equal to the start date, a due date in the past on creation, a duration spanning DST or a leap second.
- Timezones: a user in a different timezone from the server viewing the same record. A date only field near midnight UTC. This is where "the appointment moved a day" bugs live.
- Ranges: min equal to max, min greater than max, a range of zero length, a range spanning years.

## 7. File upload

- Zero byte file. One byte file. File exactly at the limit. File one byte over. File far over (multi GB) to check whether the limit is enforced before or after the whole body is buffered.
- Wrong type with a right extension: an executable renamed `.jpg`, a `.pdf` that is actually HTML, a real image with a `.pdf` extension. Type must be sniffed from content, not extension.
- Hostile filenames: `../../../etc/passwd`, a 300 character name, unicode and RTL in the name (`invoice\u202Egnp.exe`), a name that is only an extension, duplicate names uploaded twice, a name with a null byte.
- SVG containing a script (stored XSS if served inline rather than as an attachment).
- 100 files at once. Then upload while offline. Then cancel mid upload and check for orphaned storage objects.
- Upload, then delete the parent record, then check whether the storage object still exists and is still reachable by its URL.
- HEIC, and a JPEG with corrupt EXIF or an enormous EXIF payload.
- Image with absurd dimensions (50000x50000) to check for decompression bombs in thumbnailing.

## 8. Network and failure injection

- Throttle to slow 3G and repeat the core flow. Look for double submissions caused by impatient clicking.
- Kill a request mid flight (offline toggle at the moment of submit). Does the UI show a real error, or does it show success?
- Force the API to return 500, 401, 403, 429, and an empty 200 body. Every one should produce a distinct, honest UI state.
- Return valid JSON with unexpected shape (null where an object is expected, an array where an object is expected, a missing field).
- Very slow response (30s). Is there a timeout? Does the user get a spinner forever?
- Go offline mid form, come back online, submit. Then submit while offline and reconnect.
- Rapid repeated requests to trigger rate limiting, then confirm the error is a real message rather than a raw 429 body.

## 9. Session and auth lifecycle

- Let the token expire while a long form is open, then submit. Draft data should not vanish.
- Log out in tab A while tab B is mid edit.
- Change the password in one session, then act in the other.
- Downgrade the user's role in the DB mid session, then hit an endpoint that needed the old role.
- Delete the user's tenant membership mid session.
- Tamper with the JWT: change a claim, resign with a wrong key, use an expired one, use one from a different project.
- Log in with the same account in two browsers and act simultaneously.
- Password reset link: use twice, use after expiry, use after the password already changed, request many in a row.

## 10. Realtime, webhooks, background jobs

- Deliver the same webhook twice (Stripe will do this in real life). Confirm idempotency by checking that no duplicate row or double charge results.
- Deliver webhooks out of order (`updated` before `created`).
- Deliver a webhook for an entity that was deleted locally.
- Deliver a webhook with a bad signature, then with no signature.
- Drop a realtime subscription (offline), mutate data elsewhere, reconnect. Does the client resync, or does it show stale data forever?
- Two clients subscribed to the same channel, one mutates, check the other's view against the DB.
- A job that fails halfway: is it retried, and is the retry safe?

## 11. Navigation and browser behavior

- Browser back after submit. Back after delete. Back after logout (cached page with data?).
- Forward button after back.
- Refresh mid multi step wizard. Refresh mid upload. Refresh right after submit.
- Deep link directly to step 4 of a wizard without completing steps 1 to 3.
- Open every link in a new tab and check that state is not held only in memory.
- Bookmark a filtered list view, then load it fresh.
- Browser zoom at 200% and 50%. Browser translate on. Dark mode forced by the OS.
- Paste a very large clipboard payload into a field. Paste an image into a text field.
- Autofill the whole form with the browser's saved data.
- Disable JavaScript entirely if the app claims to server render.

## 12. Accessibility and viewport

- 320px width. Then 4K. Then a very short viewport (500px tall) to catch modals with no internal scroll.
- Keyboard only: complete the core flow with Tab, Shift+Tab, Enter, Space, Escape. Focus must never be trapped or lost. Escape must close what it opened.
- Screen reader labels on icon only buttons.
- Long content: a project name of 200 characters in every list, table, breadcrumb, and PDF header.
- Empty states: zero projects, zero line items, zero files. Then one. Then 10,000 (does the list virtualize or hang?).
