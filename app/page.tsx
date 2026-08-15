import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { GenLayerSection } from "@/components/landing/genlayer-section";
import { Hero } from "@/components/landing/hero";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Features />
      <GenLayerSection />
      <FinalCta />
    </>
  );
}
