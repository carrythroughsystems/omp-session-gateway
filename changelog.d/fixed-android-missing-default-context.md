- Qualification: an Android Chrome evaluation that CDP rejects because a navigation replaced the
  page's default execution context now waits up to 15 seconds for a new one, without re-running,
  re-attaching or navigating; destruction, timeouts and page exceptions still fail at once.
