import type { APIRoute } from "astro";
import { feedItems, feedResponse } from "../../../lib/feed";
import { CURRENT_TEAM_IDS, franchise } from "../../../lib/teams";

export function getStaticPaths() {
  return CURRENT_TEAM_IDS.map((team) => ({ params: { team } }));
}

export const GET: APIRoute = ({ site, params }) => {
  const team = params.team!;
  const f = franchise(team);
  return feedResponse(
    site!,
    `${f.full} の去就 新着 | プロ野球去就アーカイブ`,
    `${f.full}の引退・戦力外・FA・移籍・監督コーチ人事の新着`,
    feedItems((r) => r.team === team || r.toTeam === team),
  );
};
