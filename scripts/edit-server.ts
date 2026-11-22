/**
 * 確認用エディタ（npm run edit → http://127.0.0.1:4330/）。
 * 「自動取得・未確認」の下書きを、出典の抜粋と並べて表示し、照合できたものを「確認済み」にする。
 * 誤りなら「取り消す」で下書きを消す。
 *
 * 受け付けるのは 127.0.0.1 からだけ（外部には公開しない。認証は無い前提なので、ほかのアドレスで待ち受けないこと）。
 * 書き換えるのは data/events/manual/*.yaml の status だけ。push はしない（コミットと push は本人が行う）。
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { IntaiEvent } from "../src/lib/schema";
import { dataset } from "../src/lib/data";

const dir = join(process.cwd(), "data", "events", "manual");
const PORT = 4330;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function load(): { file: string; e: IntaiEvent }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((file) => ((parse(readFileSync(join(dir, file), "utf-8")) ?? []) as IntaiEvent[]).map((e) => ({ file, e })));
}

function update(file: string, id: string, action: "verify" | "drop") {
  if (!/^\d{4}\.yaml$/.test(file)) throw new Error("bad file");
  const p = join(dir, file);
  const list = (parse(readFileSync(p, "utf-8")) ?? []) as IntaiEvent[];
  const next = action === "drop" ? list.filter((e) => e.id !== id) : list.map((e) => (e.id === id ? { ...e, status: "verified" as const } : e));
  writeFileSync(p, stringify(next, { lineWidth: 0 }));
}

function page(): string {
  const people = dataset().people;
  const items = load().filter(({ e }) => e.status === "auto_unverified");
  const rows = items
    .map(({ file, e }) => {
      const name = people.get(e.person)?.name ?? e.person;
      const src = e.sources
        .map((s) => `<div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title ?? s.url)}</a><blockquote>${esc(s.quote ?? "（抜粋なし）")}</blockquote></div>`)
        .join("");
      return `<tr><td>${e.season}<br>${esc(e.date ?? "")}</td><td><b>${esc(name)}</b><br>${esc(e.type)} ${esc(e.note ?? "")} ${esc(e.team ?? "")}${e.toTeam ? " → " + esc(e.toTeam) : ""}${e.toOrg ? " → " + esc(e.toOrg.name) : ""}</td><td>${src}</td>
      <td><form method="post"><input type="hidden" name="file" value="${esc(file)}"><input type="hidden" name="id" value="${esc(e.id)}">
      <button name="action" value="verify">確認済みにする</button> <button name="action" value="drop">取り消す</button></form></td></tr>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>確認用エディタ</title>
  <style>body{font-family:system-ui;margin:16px;background:#f2f3ee;color:#1f2633}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #b9c2b8;padding:8px;vertical-align:top}blockquote{margin:4px 0;padding-left:8px;border-left:3px solid #b3261e}</style>
  <h1>自動取得・未確認 ${items.length} 件</h1><p>出典を開いて、抜粋と内容（区分・球団・日付）が合っていれば「確認済みにする」。違っていれば「取り消す」。</p>
  <table>${rows || "<tr><td>未確認の下書きはありません。</td></tr>"}</table>`;
}

createServer((req, res) => {
  if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1" && req.socket.remoteAddress !== "::1") {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      try {
        update(f.get("file") ?? "", f.get("id") ?? "", f.get("action") === "drop" ? "drop" : "verify");
        res.writeHead(303, { location: "/" }).end();
      } catch (e) {
        res.writeHead(400).end(String(e));
      }
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
}).listen(PORT, "127.0.0.1", () => console.log(`確認用エディタ: http://127.0.0.1:${PORT}/ （止めるときは Ctrl+C）`));
