- Leave the session rows in place when a directory refresh changes nothing. A tap that spanned
  such a refresh was dropped and keyboard focus could move. A refresh that changes a row still
  replaces the list. Row actions now use the current session generation and request.
