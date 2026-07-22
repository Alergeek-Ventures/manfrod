---
name: desk-booking
description: Reserve or look up office desk bookings for a specific date, or show the desk map. Use when someone asks to book/reserve a desk, cancel a booking, asks who's sitting where or what's free on a given day, or asks to add/edit a desk (equipment, location, map position).
---

# Desk booking

## Reserving a desk
User asks to reserve/book a desk on a date (including relative dates like
"jutro", "w piątek" — resolve them against `[Current Context]`) → call
`reserve_desk` with the desk label and date.

If the user names a requirement instead of a specific desk (e.g. "chcę
biurko z monitorem", "coś z mac mini") → call `list_desks` first, pick a
free desk matching the requirement, call `reserve_desk` for it, and tell the
user which desk you picked.

If `reserve_desk` reports the desk is already booked or permanently assigned
to someone, say so plainly and suggest checking `list_desks` for
alternatives — don't retry with the same desk.

A user can only hold one desk per date. If someone already has a desk booked
on a date and asks to change it (a different desk, same day), just call
`reserve_desk` again with the new desk — their old reservation for that date
is automatically dropped, so don't call `cancel_desk_reservation` first.

## Cancelling
User asks to cancel/free up their desk → call `cancel_desk_reservation` with
the desk label and date. Only their own reservations can be cancelled.

## Looking up who's where
User asks who's sitting where, what's free, or wants a written list → call
`list_desk_reservations` (plain text). If they explicitly want to *see* the
office/map → call `show_desk_map` instead, which posts an image to the
current channel.

## Managing desks (admin only)
User asks to add/edit/remove a desk, change its equipment, location, or map
position → call `add_desk`, `update_desk`, or `deactivate_desk` directly.
Don't pre-filter based on who's asking — the tool itself checks admin
status and returns a refusal message if the caller isn't allowed to; just
relay whatever it says.
