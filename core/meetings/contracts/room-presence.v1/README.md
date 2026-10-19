# room-presence.v1

Bot → mutable meeting channel → authorized gateway subscriber. `meeting.presence.v1` carries
opaque visible participant IDs, display labels, observation time and whether the visible set agrees
with the meeting's displayed total. `meeting.activity.v1` reports 300ms sustained human speech.

Names are labels only, never identity grants. Absence, staleness, incomplete roster or a changed set
invalidates audience-sensitive work. Pathwarden verifies organization identity separately with
Google participant sessions or an explicit host confirmation. General questions can use an empty
meeting context; historical/private content requires the stronger audience boundary.

Every presence frame carries `complete` and a bot-generated `revision` retained across heartbeats,
regenerated on every roster/completeness change. Signed delivery binds this exact revision;
returning to an earlier roster does not revive an old command.
