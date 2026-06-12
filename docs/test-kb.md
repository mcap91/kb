# test_kb — Mock Consuming-Repo Fixture

`test_kb` is a disposable **consuming repo** used to test `kb`'s consumer-facing workflows end to
end. It is a **separate private GitHub repo** (`github.com/mcap91/test_kb`), checked out as a
**sibling** of `kb` at `../test_kb`.

## Why it exists

`kb` is a tool that operates on *other* repositories via `--dir`. To exercise that path —
`bootstrap`, wiki `create`/`lint`/`generate`, PLN plans + execution-tracker validation, dispatch
handoffs, and graph extraction — we need a stable target repo that is safe to mutate and reset.
`test_kb` is that target.

It is a **real, version-controlled private repo** (not untracked scratch) on purpose, so it stops
disappearing. Previously it lived as an untracked `../test_kb` directory with no recreate path, so
any cleanup or fresh machine lost it and nobody knew how to rebuild it. Now a wipe is a one-command
non-event.

## Relationship to kb (important)

- `test_kb` is a **sibling**, not nested in `kb`. `git clone kb` does **not** bring it — create or
  clone it separately.
- Because it lives outside `kb`, `git clean` inside `kb` cannot reach it. (The kb `git clean -ffdx`
  hazard is about the nested `wiki/` repo — a different thing.)
- All `kb` commands target it with `--dir ../test_kb`, e.g. `npm run wiki -- lint --dir ../test_kb`.

## Create / recreate

From a `kb` checkout:

```
npm run setup:test-kb
```

Idempotent: if `../test_kb` already exists it does nothing; otherwise it bootstraps the scaffold,
commits, and (via `gh`) creates the private repo and pushes. Requires `gh` authenticated with
`repo` scope (`gh auth status`).

### Manual steps (what the script does)

```
mkdir ../test_kb
npm run wiki -- bootstrap --dir ../test_kb --repo mcap91/test_kb
git -C ../test_kb init -b main
git -C ../test_kb add -A
git -C ../test_kb commit -m "chore: bootstrap test_kb mock consuming-repo fixture"
gh repo create mcap91/test_kb --private --source=../test_kb --remote=origin --push
```

If the private repo already exists remotely, just clone it:

```
git clone https://github.com/mcap91/test_kb.git ../test_kb
```

## Use it

```
npm run wiki -- create --prefix PLN --title "..." --dir ../test_kb
npm run wiki -- validate-plan --plan PLN-0001 --dir ../test_kb
npm run wiki -- lint --dir ../test_kb
npm run wiki -- generate --dir ../test_kb
npm run graph -- --dir ../test_kb
```

## Reset to a clean fixture

After a test run, restore the pristine state:

```
git -C ../test_kb checkout -- .
git -C ../test_kb clean -fd
```

(`-fd`, single `-f`. Never `-ff`.)

## Conventions

- Treat `test_kb` as disposable. Don't store anything you can't regenerate.
- Keep the committed state equal to a clean bootstrap. Demonstrations (sample PLNs, broken trackers,
  etc.) are created and then reset — not committed — unless you intend to enrich the fixture.
