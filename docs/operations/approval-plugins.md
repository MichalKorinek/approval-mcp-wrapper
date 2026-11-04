# Approval presentation plugins

Open **Upstreams**, edit an MCP connection, and choose its **Presentation plugin**. The plugin pin is stored on that upstream, so two servers of the same type can use different display names and metadata while sharing the same plugin. Existing connections without a plugin continue to use the generic approval view.

The built-in plugin IDs are:

| Plugin ID | Connected server | Covered tools |
| --- | --- | ---: |
| `email` | Mail search and reading | 9 |
| `geo` | Device location and visits | 8 |
| `imcp` | macOS contacts, calendar, maps, phone, reminders, weather | 27 |
| `krkonoskewellness` | Wellness catalog and bookings | 4 |
| `minutes` | Minutes / Signal | 35 |
| `whatsapp` | WhatsApp chats and messages | 13 |

All plugins provide Czech and English operation titles, highlight the arguments needed to understand the action, retain all arguments in a collapsed technical section, and mark potentially consequential requests with an appropriate risk level. Dates and times are formatted for the viewer in readable fields; raw values remain unchanged in the technical section and upstream call. Unknown future tool names fall back to a generic presentation. The wellness `book` tool is shown as a preview unless `confirm=true`; a confirmed booking is marked dangerous and has no reusable grant scope. Minutes group termination is likewise dangerous and has no reusable scope.

Presentation plugins do not change profile policy or automatically require approval. Configure tool outcomes in **Access → Profiles**. WhatsApp and macOS phone presentations make bounded, read-only contact lookups; WhatsApp chat operations also look up the chat name, and media downloads look up the referenced message text. Wellness booking and availability presentations read the `services` catalog to resolve service and therapist names. If a lookup fails or cannot match the exact ID, the presentation retains the raw identifier without inventing a name. Minutes message actions similarly look up the message, show its text and conversation, and offer a reusable grant for the verified conversation rather than for one message ID. Without a verified conversation, no message-specific reusable scope is offered. Grant predicates always use stable IDs, never display names.

For iMCP `events_delete`, the server performs a read-only `events_fetch` lookup in a bounded time window (around the requested occurrence, or from 30 days ago through one year ahead when no start is supplied). Only an exact event identifier and, when supplied, matching occurrence may provide the visible event title and calendar. The verified occurrence end is shown only when `start` was supplied; without it, the card warns that a recurring occurrence cannot be verified. If the lookup fails or finds no exact match, the card explicitly marks the event as unidentified. The complete identifier remains expandable and the original arguments stay in the technical section. The deletion span is always shown, including its `thisEvent` default. Older journal entries retain the presentation captured when they were created; the lookup does not rewrite history.

The approval dialog also offers **Whole tool (any arguments)**. Selecting it
enables **Allow for 1 hour**, even when a plugin proposes no reusable scope.
This grant has no argument predicates and applies to the same agent, upstream
and tool until its expiry; it can be revoked in **Access**. Other chats,
recipients and argument values therefore do not prompt again during that hour.
Explicit denies and profile tool visibility still apply. Tool-wide approval
cannot be made permanent through this option. Existing plugin scopes remain
available with their own duration restrictions.

The catalog was checked against the live MCP endpoint on 2026-10-05. If an upstream adds or renames tools, update the corresponding plugin definition and its tests before relying on specialized presentation for the new operation.
