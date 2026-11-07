- Record outstanding fleet asks only after push acceptance for exact restart reconciliation; release
  cancelled sends immediately, retry transport failures after each delivery's own 30-second cooldown
  without changing clear sequences, and exclude grant-less sources from badges and stale retention.
