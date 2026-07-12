// Plain-language explanations of what each requirement field actually means -- shared between
// RequirementsPanel (editing real requirements) and the What-If Simulator (exploring hypothetical
// ones), since both panels ask about the exact same underlying fields and a user shouldn't get a
// different explanation of "budget" depending on which screen asked. Static text: the MEANING of
// a field doesn't change per project, only the suggested/current values do.
export const FIELD_EXPLANATIONS: Record<string, string> = {
  expectedScale:
    "How many people will use this and how often. Bigger numbers mean the system needs to handle more simultaneous requests without slowing down.",
  readWritePattern:
    "Whether your app mostly saves new data (writes) or mostly looks up existing data (reads). This changes what kind of database setup works best.",
  dataNature:
    "What kind of information you're storing — structured records like accounts, or files like photos and PDFs. This affects which storage technology fits.",
  latencySensitivity:
    "How fast responses need to feel to users. A live chat needs near-instant responses; a monthly report can take longer.",
  budget: "Your rough monthly spending ceiling for cloud infrastructure — steers us toward cheaper or more premium services.",
  teamMaturity:
    "How much cloud/ops experience your team has. Less experience steers us toward simpler, more managed services that need less babysitting.",
  compliance:
    "Any legal or industry rules your data has to follow (e.g. healthcare or payment regulations). This can require extra security components.",
  functional:
    "The concrete features your product needs. Each one may translate into specific infrastructure — e.g. \"SMS reminders\" needs a messaging integration.",
  industry:
    "Whether this falls under a regulated industry (fintech, healthtech). Detected industries automatically add required compliance components like audit logs or a dedicated PHI/card-data vault.",
};
