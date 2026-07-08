import { productContext } from "@/lib/planning-data";
import { getPlanningArtifacts } from "@/lib/planning-store";
import IntakeForm from "@/app/components/IntakeForm";

export const dynamic = "force-dynamic";

type Artifact = Awaited<ReturnType<typeof getPlanningArtifacts>>[number];

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-700">
      {children}
    </span>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <article className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-200/80">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-cyan-700">{artifact.priority}</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">{artifact.title}</h2>
        </div>
        <span className="w-fit rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white">
          #{artifact.displayOrder.toString().padStart(2, "0")}
        </span>
      </div>

      <p className="mt-4 text-base leading-7 text-slate-700">{artifact.summary}</p>

      <div className="mt-6 space-y-6">
        {artifact.content.sections.map((section) => (
          <section key={section.heading} className="rounded-3xl bg-slate-50 p-5">
            <h3 className="text-lg font-semibold text-slate-950">{section.heading}</h3>
            <p className="mt-2 leading-7 text-slate-700">{section.body}</p>
            {section.bullets ? (
              <ul className="mt-4 grid gap-2 text-sm text-slate-700">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      {artifact.content.tables ? (
        <div className="mt-6 space-y-6">
          {artifact.content.tables.map((table) => (
            <div key={table.title} className="overflow-hidden rounded-3xl border border-slate-200">
              <div className="border-b border-slate-200 bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
                {table.title}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-white text-slate-950">
                    <tr>
                      {table.columns.map((column) => (
                        <th key={column} scope="col" className="px-5 py-3 font-semibold">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white text-slate-700">
                    {table.rows.map((row) => (
                      <tr key={row.join("|")}>
                        {row.map((cell, index) => (
                          <td key={`${cell}-${index}`} className="max-w-[28rem] px-5 py-4 align-top leading-6">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {artifact.content.tasks ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {artifact.content.tasks.map((taskGroup) => (
            <div key={taskGroup.phase} className="rounded-3xl border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-950">{taskGroup.phase}</h3>
              <ol className="mt-4 space-y-3 text-sm text-slate-700">
                {taskGroup.items.map((item, index) => (
                  <li key={item} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-600 text-xs font-bold text-white">
                      {index + 1}
                    </span>
                    <span className="leading-6">{item}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default async function HomePage() {
  const artifacts = await getPlanningArtifacts();
  const lastUpdated = artifacts.at(-1)?.updatedAt;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#cffafe,transparent_36%),linear-gradient(135deg,#f8fafc_0%,#eef2ff_48%,#ecfeff_100%)] px-6 py-8 text-slate-900 sm:py-12">
      <section className="mx-auto max-w-7xl">
        <div className="overflow-hidden rounded-[2.5rem] border border-white/70 bg-white/80 shadow-2xl shadow-slate-300/40 backdrop-blur">
          <div className="grid gap-8 p-6 sm:p-10 lg:grid-cols-[1.15fr_0.85fr] lg:p-12">
            <div>
              <Badge>Context understood</Badge>
              <h1 className="mt-6 max-w-4xl text-4xl font-black tracking-tight text-slate-950 sm:text-6xl">
                {productContext.name}
              </h1>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-slate-700">{productContext.concept}</p>
              <div className="mt-8 rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
                <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-700">Recommended next move</p>
                <p className="mt-2 text-xl font-bold text-emerald-950">
                  Build the Phase 1 technical specification first: data model, API contracts, and deterministic decision rules.
                </p>
                <p className="mt-3 leading-7 text-emerald-900">
                  This is the highest-leverage priority because it defines the canonical inputs and outputs that brainstorming, HLD generation, AWS mapping, cost estimates, and future architecture deltas all depend on.
                </p>
              </div>
            </div>

            <div className="space-y-6">
              <IntakeForm />

              <aside className="rounded-[2rem] bg-slate-950 p-6 text-white">
                <p className="text-sm font-semibold uppercase tracking-[0.14em] text-cyan-300">Planning console</p>
                <dl className="mt-6 grid gap-4">
                  <div className="rounded-2xl bg-white/10 p-4">
                    <dt className="text-sm text-slate-300">Current priority</dt>
                    <dd className="mt-1 text-lg font-semibold">Phase 1 engineering spec</dd>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-4">
                    <dt className="text-sm text-slate-300">Stored artifacts</dt>
                    <dd className="mt-1 text-lg font-semibold">{artifacts.length} planning records in Postgres</dd>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-4">
                    <dt className="text-sm text-slate-300">API endpoint</dt>
                    <dd className="mt-1 break-all font-mono text-sm text-cyan-100">/api/planning/phase-1</dd>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-4">
                    <dt className="text-sm text-slate-300">Last seeded</dt>
                    <dd className="mt-1 text-sm font-semibold">
                      {lastUpdated ? lastUpdated.toISOString() : "Pending seed"}
                    </dd>
                  </div>
                </dl>
              </aside>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <section className="rounded-[2rem] border border-slate-200 bg-white/85 p-6 shadow-sm backdrop-blur">
            <h2 className="text-xl font-bold text-slate-950">Finalized user journey</h2>
            <ol className="mt-5 grid gap-3 text-sm text-slate-700">
              {productContext.journey.map((step, index) => (
                <li key={step} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-bold text-white">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-[2rem] border border-slate-200 bg-white/85 p-6 shadow-sm backdrop-blur">
            <h2 className="text-xl font-bold text-slate-950">Internal system modules</h2>
            <div className="mt-5 flex flex-wrap gap-2">
              {productContext.modules.map((module) => (
                <span key={module} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {module}
                </span>
              ))}
            </div>
          </section>
        </div>

        <section className="mt-10 space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Badge>Claude Code handoff</Badge>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950">Engineering-ready planning artifacts</h2>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              These records are persisted as structured JSON rather than static copy so later implementation can evolve them into editable specs, generated documents, and architecture-version diffs.
            </p>
          </div>
          <div className="grid gap-6">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
