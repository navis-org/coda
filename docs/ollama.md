# Ollama — running the assistant on your own machine

Coda's assistant (the robot icon in the toolbar, or `/`) describes a change and builds it on the canvas. It normally talks to a cloud provider with an API key. **Ollama** is the other option: a model running on your own computer, with no key, no account, and nothing leaving the machine.

This guide is the whole setup, in four steps — install, pull a model, let the browser in, point Coda at it. Budget twenty minutes, most of it waiting for a download.

Two things worth knowing before you spend the disk space:

- **Coda's prompt is large.** The node catalogue it sends is ~13k tokens, so a model with a small
  context window is not just slower, it is wrong — see [step 2](#2-pull-a-model).
- **The mileage on local plans may vary.** Coda's assistant has been tested against Anthropic's latest models; other providers (including Ollama) have had their reachability checked and nothing else. Depending on which model you pull, the quality of the plans may be lower than what you get from frontier models in the cloud.

---

## 1. Install Ollama

### macOS

Download the app from [ollama.com/download](https://ollama.com/download), mount the `.dmg` and drag **Ollama** to `/Applications`. On first launch it offers to put the `ollama` CLI in `/usr/local/bin`; say yes, since every command below uses it!

Needs macOS 14 (Sonoma) or newer. Apple Silicon gets GPU acceleration; Intel Macs are CPU only and will be slow enough that a 14B model is not worth attempting.

The app runs the server itself. Don't also run `ollama serve` in a terminal — the second one fails with `address already in use`.

### Windows

Download and run the installer from [ollama.com/download](https://ollama.com/download). It installs per-user and needs no administrator rights. Ollama then lives in the system tray and starts with your session.

### Linux

```shell
curl -fsSL https://ollama.com/install.sh | sh
```

The installer sets up a `systemd` service running as an `ollama` user, which matters for [step 3](#3-let-the-browser-in) — the environment variable has to reach *that* service, not your shell. If you would rather run it in the foreground, skip the service and use `ollama serve`.

### Check it is up

```shell
ollama -v
curl http://localhost:11434
```

The second should answer `Ollama is running`. That endpoint is exactly what Coda's **Server** field points at.

---

## 2. Pull a model

### What Coda needs from one

| Requirement | Why | What happens if it is not met |
| --- | --- | --- |
| **≥ 16k context** | The node catalogue alone is ~13k tokens; Coda asks for `num_ctx: 16384` on every request | The prompt is **silently truncated from the front** and the model answers confidently about a node list it was never shown |
| **A GGUF build** | Coda sends its plan schema as `format`, which becomes a compiled grammar in llama.cpp. Other engines accept the field and ignore it | Plans come back in the wrong shape — valid JSON, so nothing raises, with no actions in it |
| **Fits in memory** | The weights plus a 16k KV cache have to sit in RAM or VRAM | It spills to CPU and a single plan takes minutes |

Coda handles the first by asking for 16k explicitly, which is why the Ollama default of 4k on a
machine with under 24 GiB of VRAM is not a problem — but a model that was *trained* with a
smaller window clamps, and nothing reports it.

### Recommendations

Sizes and context windows below were read off ollama.com:

| Model | Disk | Context | Why |
| --- | --- | --- | --- |
| `qwen2.5-coder:14b` | 9.0 GB | 32K | **Coda's default.** What the dropdown opens on |
| `gemma4:12b` | 7.6 GB | 256K | Newer, native function-calling, a gigabyte smaller |
| `qwen2.5:14b` | 9.0 GB | 32K | The general-purpose sibling of the default |
| `mistral-nemo` | 7.1 GB | 128K | 12B, a reasonable middle |
| `llama3.1:8b` | 4.9 GB | 128K | The smallest worth trying |
| ~~`gemma2:9b`~~ | 5.4 GB | **8K** | **Avoid.** Its window is below Coda's prompt |

Pick by the memory you have, not by the leaderboard: roughly 8 GB of RAM → an 8B model, 16 GB → 12–14B comfortably, 32 GB+ → anything on the list.

`gemma2:9b` is in Coda's own "Available to pull" list and is the one entry there that predates
the prompt getting large. It will answer, and it will answer about a catalogue it only half
received.

```shell
ollama pull qwen2.5-coder:14b
ollama list
```

Personally, I'm using `qwen3.8:27b` on a 32 GB MacBook M3 Max. It is not among the default models but Coda will happily list it if it's available in your Ollama.

> [!CAUTION]
> **The Apple Silicon trap**
> Several models publish MLX builds beside the GGUF ones — `gemma4:12b-mlx` next to `gemma4:12b`. The MLX build is faster on a Mac but it *quietly ignore Coda's plan schema*. This is a known Ollama bug - until this is fixed, pull the plain tag.
>
> Coda detects MLX builds and warns, twice: the model's row in the dropdown reads `… — ignores JSON schema`, and **Test** returns the success line with a warning beside it.

### Check what actually got allocated

Worth doing once, *after* you have asked the assistant something — the context is set by the request, so a model loaded from the CLI shows Ollama's own default instead:

```shell
ollama ps
```

```
NAME                     ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen2.5-coder:14b        …               10 GB     100% GPU     16384      4 minutes from now
```

`CONTEXT` should read at least `16384`. Less than that is a model clamping to its own trained window, which is the silent-truncation case above. `PROCESSOR` should say `100% GPU`, or be CPU-only knowingly — a split means the model did not fit and every plan will crawl.

---

## 3. Let the browser in

Ollama refuses cross-origin requests from pages it has not been told about, and a browser reports that refusal indistinguishably from a dead server. This is the step people miss.

### You may not need to do anything

Ollama **always** allows these, whatever you configure:

```
http://localhost   http://localhost:*   https://localhost   https://localhost:*
http://127.0.0.1   http://127.0.0.1:*   (and the https pair)
http://0.0.0.0     http://0.0.0.0:*     (and the https pair)
```

So if you are running Coda locally — `pnpm dev` on `http://localhost:5173`, or `pnpm preview` — **it already works.** Skip to [step 4](#4-point-coda-at-ollama).

`OLLAMA_ORIGINS` *adds to* that list rather than replacing it, so nothing you set here can lock you out of a local dev server.

### For the hosted app

[navis-org.github.io/coda](https://navis-org.github.io/coda/) is a different origin, and it has to be named exactly — scheme and host, no path:

```
https://navis-org.github.io
```

#### macOS

If Ollama runs as the app (the usual case), the variable has to be set where a GUI application will see it:

```shell
launchctl setenv OLLAMA_ORIGINS "https://navis-org.github.io"
```

Then **quit Ollama from the menu bar and start it again** — it reads the environment once, at launch.

`launchctl setenv` lasts until you log out or reboot. To make it permanent, either add a LaunchAgent, or stop using the app's server and run your own:

```shell
OLLAMA_ORIGINS="https://navis-org.github.io" ollama serve
```

#### Linux

The service runs as its own user, so your shell's environment never reaches it:

```shell
sudo systemctl edit ollama.service
```

Add, under `[Service]`:

```ini
[Service]
Environment="OLLAMA_ORIGINS=https://navis-org.github.io"
```

Save, then:

```shell
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Running it in the foreground instead? `OLLAMA_ORIGINS="https://navis-org.github.io" ollama serve`.

#### Windows

Ollama inherits your user environment variables.

1. Quit Ollama from the system tray.
2. Open **Settings** (Windows 11) or **Control Panel** (Windows 10) and search for
   *environment variables*.
3. Click **Edit environment variables for your account**.
4. Add a new user variable `OLLAMA_ORIGINS` with the value `https://navis-org.github.io`.
5. OK / Apply, then start Ollama again from the Start menu.

### Verify it before opening Coda

This asks Ollama the same question the browser will:

```shell
curl -i -X OPTIONS http://localhost:11434/api/chat \
  -H "Origin: https://navis-org.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

The response must carry:

```
Access-Control-Allow-Origin: https://navis-org.github.io
```

No such header means the variable did not reach the running server — nearly always because it was set in a shell rather than for the service, or because Ollama was not restarted.

Several origins are comma-separated: `OLLAMA_ORIGINS="https://navis-org.github.io,https://example.org"`.

---

## 4. Point Coda at Ollama

1. Open **Connections** — the branch icon in the toolbar.
2. Choose the **AI assistant** section.
3. **Provider** → `Ollama (local)`. The key field disappears; there is nothing to paste.
4. **Server** → `http://localhost:11434` (already filled in; change it only if you moved the port with `OLLAMA_HOST`).
5. **Model** → the dropdown separates **On this machine** from **Available to pull**. Yours is in the first group. If the list looks stale, press **↻** beside it — that asks the server what is installed rather than guessing.
6. Press **Test**.
7. Press **Save**. The assistant does not use the new provider until you do.

A working Test reads:

```
Works — qwen2.5-coder:14b — 3 models installed, 16k context
```

The `16k context` is what Coda is going to ask for, not what the model can do — so it says the same thing for every model. Confirm the model's own window in the table above.

A second line in amber under that is the MLX/GGUF warning from step 2. It sits *beside* the success rather than replacing it, and it means what it says: the connection works, the answers may be malformed.

---

## 5. Ask for something

Press `/`, or the robot icon in the toolbar. Type a change:

> add a bar chart of the connectivity table grouped by preType

The plan applies to the canvas immediately — the graph above *is* the preview, and the whole edit is one `Ctrl-Z` / `⌘Z`. Below the ask box you get a summary of what changed and anything the edit left for you to finish.

Local models do better with one change at a time. If a plan comes back empty or malformed, ask for a smaller step before blaming the setup.

---

## Which browsers this works in

A page served over **https** reaching a plain-**http** server on your own machine is the awkward part, and browsers disagree about it. This only matters for the hosted app; a locally served Coda is http talking to http and none of it applies.

| Browser | What happens |
| --- | --- |
| **Chrome / Edge 142+** | Works, with one extra click. Chrome's [Local Network Access](https://developer.chrome.com/blog/local-network-access) permission prompt appears — *"Look for and connect to any device on your local network"*. **Allow** it. Granting it also exempts the request from the mixed-content check; the local server needs no special headers |
| **Firefox 84+** | Works. `http://localhost` has not been treated as mixed content since [bug 1488740](https://bugzilla.mozilla.org/show_bug.cgi?id=1488740) |
| **Safari** | **Does not work.** Safari still blocks https → `http://localhost` as mixed content ([WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934), open since 2017), with no setting to permit it |

If your browser refuses, or you would rather not depend on any of the above, **run Coda locally**:
clone the repo, `pnpm install && pnpm dev`, and open the `http://localhost:5173` it prints. That
path needs no `OLLAMA_ORIGINS` and no permission prompt at all.

---

## Troubleshooting

Coda's messages are specific on purpose; each one below names its own fix.

| What Coda says | What it means |
| --- | --- |
| `Could not reach http://localhost:11434. Is the server running, and is it set to accept requests from this page?` | One of three: Ollama is not running (`curl http://localhost:11434`), the origin is not allowed ([step 3](#3-let-the-browser-in)), or the browser blocked it before it was sent (Safari, or a denied Chrome prompt). A browser reports all three identically, which is why the message lists them |
| `<model> is not pulled on this machine. Run ollama pull <model>, or choose one you have: …` | Coda asked `/api/tags` and the name in the dropdown is not among the answers. The models it lists after the colon are really there |
| `Nothing pulled yet — run ollama pull … , then refresh` | The server answered and has no models. Pull one, then press **↻** |
| `The reply hit the length limit before it finished, so the plan is incomplete. Ask for a smaller change.` | The answer ran out of room inside the 16k window. Genuinely ask for less — or use a model with a larger window |
| `… is not a GGUF build, so it runs on an engine that accepts the JSON schema and ignores it` | The MLX trap. Pull the plain tag |
| A plan that reads like a sensible sentence but changes nothing | Same cause as the row above, or a model whose context clamped below the prompt. Check `ollama ps` |
| `address already in use` when starting `ollama serve` | The desktop app is already running one. Use it, or quit the app first |

Server-side logs, if you need them: macOS `~/.ollama/logs/server.log`,
Linux `journalctl -u ollama -f`.

---

## What is sent where

Every request the assistant makes carries the node catalogue, **the graph on your canvas**, and
what you typed. With Ollama that goes to `localhost` and no further — no account, no key, no
third party, and it works with no network at all once the model is pulled.

The connectome data itself is a separate question and unaffected by any of this: that still comes
from neuPrint over the network, with its own token, configured in the same **Connections** dialog
under *Data sources*.

---

## Reference

- [Ollama FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx) — environment variables
  per platform, model storage locations, proxies
- [Ollama context length](https://github.com/ollama/ollama/blob/main/docs/context-length.mdx) —
  the 4k / 32k / 256k defaults by VRAM, and `ollama ps`
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [ollama.com/search](https://ollama.com/search) — the current model library
