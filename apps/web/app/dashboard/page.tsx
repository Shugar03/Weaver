import { redirect } from "next/navigation";

// /dashboard era el nombre viejo de la vista end-to-end; ahora es /network
// (la "consola" de operación por forge vive en /forge). Redirect permanente
// para no romper links externos ni bookmarks.
export default function DashboardRedirect() {
  redirect("/network");
}
