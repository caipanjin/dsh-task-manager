# Publishing checklist

Repo: https://github.com/caipanjin/dsh-task-manager
npm:  @caipj/dsh-task-manager

The package is fully prepared (git repo initialised + committed, `npm pack`
validates cleanly: 9 files, 18 kB). What remains needs **your credentials**
(GitHub repo creation + npm login). Run these in order.

## 1. Create the GitHub repo and push

GitHub SSH is already authenticated as `caipanjin`. Create the repo (pick one):

- Web: https://github.com/new  → owner `caipanjin`, name `dsh-task-manager`,
  **Public**, do NOT add a README/.gitignore/license (we already have them).

Then push:

```bash
cd /Users/caipanjin/study/dsh_task_plugin
git remote add origin git@github.com:caipanjin/dsh-task-manager.git
git push -u origin main
```

## 2. Add the `dsh-plugin` topic (required for marketplace discovery)

- Web: repo → ⚙ (About) → Topics → add `dsh-plugin` → Save.
- Or with a token: `curl -X PUT -H "Authorization: token <TOKEN>" \
  https://api.github.com/repos/caipanjin/dsh-task-manager/topics \
  -d '{"names":["dsh-plugin"]}'`

## 3. Publish to npm (so it shows in the DSH in-app 插件中心)

```bash
npm login --registry=https://registry.npmjs.org
cd /Users/caipanjin/study/dsh_task_plugin
npm publish --registry=https://registry.npmjs.org
```

Notes:
- The package name is scoped `@caipanjin/...`; `publishConfig.access` is
  already `public`, so the scoped publish is public.
- Your local `npm config get registry` is `registry.npmmirror.com` (a mirror);
  publish must go to `registry.npmjs.org` (the flag above forces it).
- If `@caipanjin` scope doesn't exist yet, `npm publish` creates it on first
  publish under your account.

## 4. Submit to the marketplace

Open the pre-filled form (replace nothing — body is in `SUBMISSION.md`):

- https://github.com/dshplugin/dsh-plugin-hub/issues/new

Copy the title and body from `SUBMISSION.md`.

## 5. Verify

- Marketplace scans public repos with the `dsh-plugin` topic on a refresh cycle
  (usually within one cycle). Entry starts as `unconfirmed`, then `verified`.
- In-app 插件中心 shows it only if the npm package exists (step 3).
- Install test: `dsh plugin --profile web add @caipj/dsh-task-manager`
