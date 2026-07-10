# Dev Launcher

A tiny local control panel for your scattered dev projects. One list, a Run/Stop
button per project, live logs, and port-conflict handling for when three projects
all want `:5173`.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:9000**. (Change with `PORT=9001 npm start`.)

The UI (React) is bundled locally with esbuild on startup — no CDN, so it works
offline. If you edit `public/app.jsx`, restart the server to rebuild the bundle.

## Use it

- **Add project** — name, folder, the command you'd normally type (`npm run dev`,
  `dotnet run`, `pnpm dev`, …), and the port it uses.
- **Scan folder** — point it at `C:\dev` and it finds every folder with a
  `package.json` or `.csproj` so you can bulk-add.
- **Run / Stop** — Run spawns the command in that folder; Stop kills the whole
  process tree (so `npm run dev` doesn't leave the real dev server orphaned).
- **Port conflicts** — if the port is already taken, Run won't start blindly. You
  get "**:5173 — free it & run?**" and one click frees the port
  and starts your project.

Projects live in `registry.json` — plain text, edit it directly if you prefer.

## Notes for your setup

- **Force-free port** uses `netstat` + `taskkill` on Windows, `lsof` + `kill`
  elsewhere. No admin rights needed for your own processes.
- **COM/STA** Windows Services behave best as *real* services.
  For those, set the command to `sc start SageLink` (or `net start …`) instead of
  `dotnet run`, so the launcher just toggles the service.
- This is a dev tool with no auth. Keep it bound to localhost; don't expose it.
