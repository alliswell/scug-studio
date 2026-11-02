"use client";

import { useParams } from "next/navigation";
import { ProjectPage } from "@/components/ProjectPage";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <ProjectPage key={id} id={id} />;
}
