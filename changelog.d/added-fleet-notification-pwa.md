- Enable selected hosts' background alerts from the home PWA, with per-host coverage, direct grants,
  safe remote taps, and durable worker ordering. Cross-host asks follow first observation on this
  page; configured host order breaks ties, and that in-memory order resets after a cold load.
  Badge reconciliation keeps fresh hosts usable while a notification's launch is in flight.
  Unsupported or unselected fleets do not poll in the directory; Hold and Requeue stay device-local.
