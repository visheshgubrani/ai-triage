import { AdminSettings } from "../admin-gate";
import { CategoriesView } from "./categories-view";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  return (
    <AdminSettings title="Categories" current="/settings/categories">
      <CategoriesView />
    </AdminSettings>
  );
}
