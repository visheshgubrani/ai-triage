import { AdminSettings } from "../admin-gate";
import { PipelineView } from "./pipeline-view";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  return (
    <AdminSettings title="Pipeline" current="/settings/pipeline">
      <PipelineView />
    </AdminSettings>
  );
}
