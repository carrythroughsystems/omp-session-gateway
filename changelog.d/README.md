# Changelog fragments

Changelog entries are `changelog.d/` fragments; never edit `CHANGELOG.md` `[Unreleased]` directly.

Add `changelog.d/<section>-<short-slug>.md`, using one lowercase, hyphen-separated slug per entry.
The section is one of `added`, `changed`, `deprecated`, `removed`, `fixed`, or `security`.

Each fragment contains exactly one Keep-a-Changelog bullet:

- Start the first line with `- ` and non-empty text.
- Indent every continuation line with exactly two spaces. Do not add nested bullets or blank lines.
- Keep every line at most 100 characters, including indentation, and end the file with an LF newline.

For example, `fixed-stale-launch.md` could contain:

```markdown
- Revalidate the selected session generation before launch, preserving the existing card
  when discovery reports a newer generation.
```

`bun run check:repository` enforces these rules and the empty `## [Unreleased]` header.
Release preparation collects fragments in Added, Changed, Deprecated, Removed, Fixed, Security order,
then filename order within each section, and deletes the consumed files. Re-preparation preserves
existing bullets and appends the newly sorted fragments to their sections, recounting the summary.
`README.md` is documentation, not a fragment, and is never consumed.
