import { isSystemUser, listUsers, personName } from "@/lib/accounts.ts";
import { loadOffice } from "@/lib/office/layout.ts";
import { listOfficeMembers } from "@/lib/office/members.ts";
import { deskMapPath } from "@/lib/office/url.ts";
import { localToday } from "@/lib/time.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { OfficeEditor } from "./office-editor.tsx";
import { OfficeMembers, OfficeSettings, OfficePreview } from "./office-sections.tsx";

export const dynamic = "force-dynamic";

export default async function OfficePage() {
  await requireAdmin();
  const [office, users, members] = await Promise.all([loadOffice({ includeInactive: true }), listUsers(), listOfficeMembers()]);
  const today = localToday();
  const people = users
    .filter((user) => !isSystemUser(user))
    .map((user) => ({ id: user.id, name: personName(user) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  const { layout } = office;

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <OfficeEditor
        layout={{
          name: layout.name,
          width: layout.width,
          height: layout.height,
          elements: layout.elements,
          planChannelId: layout.planChannelId,
          crowdedThreshold: layout.crowdedThreshold,
        }}
        desks={office.desks.map((desk) => ({
          id: desk.id,
          label: desk.label,
          locationNote: desk.locationNote,
          equipment: desk.equipment,
          active: desk.active,
          x: desk.x,
          y: desk.y,
          width: desk.width,
          height: desk.height,
          rotation: desk.rotation,
          ownerUserId: desk.ownerUserId,
        }))}
        people={people}
      />
      <div className="grid gap-4 @4xl/main:grid-cols-2">
        <OfficeMembers members={members.map((user) => ({ id: user.id, name: personName(user) }))} people={people} />
        <OfficeSettings
          settings={{
            width: layout.width,
            height: layout.height,
            planChannelId: layout.planChannelId,
            crowdedThreshold: layout.crowdedThreshold,
          }}
        />
      </div>
      <OfficePreview src={deskMapPath(today, Date.now())} date={today} />
    </div>
  );
}
