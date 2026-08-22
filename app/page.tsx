import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { GenLayerSection } from "@/components/landing/genlayer-section";
import { Hero } from "@/components/landing/hero";
import { HomeSwitch } from "@/components/home/home-switch";

export default function HomePage() {
  return (
    /* Guests get the pitch; signed-in players get the lobby. The marketing
       sections are passed through as children so they remain server-rendered
       static markup — see HomeSwitch. */
    <HomeSwitch>
      <Hero />
      <Features />
      <GenLayerSection />
      <FinalCta />
    </HomeSwitch>
  );
}
