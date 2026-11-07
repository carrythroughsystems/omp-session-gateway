- Enable selected hosts' background alerts from the home PWA, with per-host coverage, direct grants,
  safe remote taps, and durable worker ordering. Cross-host asks follow first observation on this
  page; configured host order breaks ties, and that in-memory order resets after a cold load.
  Badge reconciliation keeps fresh hosts usable while a notification's launch is in flight.
  Unsupported or unselected fleets do not poll in the directory; Hold and Requeue stay device-local.
  Enrollment owns worker mode until it finishes, then follows actual device selection even on
  failure; unacknowledged mode changes retry on the next foreground trigger. Legacy resets replace
  the fleet badge with local asks. Unknown worker support and coverage never claim All clear;
  recovered or superseded observations reconcile again. Badge counts exclude withdrawn hosts;
  Reconnect replaces rejected grants. Alert taps wait for focus and its refresh, keep their source
  stable through launch, and preserve the selected directory scope.
