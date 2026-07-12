import ShareView from "@/app/components/ShareView";

export const dynamic = "force-dynamic";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

// A completely independent top-level route from /projects/[id] -- shares no layout logic, no
// fetch helper, no auth path with it. ShareView (a client component) does the one public data
// fetch itself; this page just resolves the route param and hands it off.
export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;
  return <ShareView token={token} />;
}
