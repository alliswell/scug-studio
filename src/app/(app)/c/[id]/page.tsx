"use client";

import { useParams } from "next/navigation";
import { ClubPage } from "@/components/ClubPage";

export default function Club() {
  const { id } = useParams<{ id: string }>();
  return <ClubPage key={id} id={id} />;
}
