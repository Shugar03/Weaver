// Logos reales vía Simple Icons CDN (verificados uno por uno).
// vLLM no tiene icono oficial: monograma tipográfico, declarado, no inventado.
const BRANDS = [
  { name: "LangChain", slug: "langchain" },
  { name: "PyTorch", slug: "pytorch" },
  { name: "Meta", slug: "meta" },
  { name: "Hugging Face", slug: "huggingface" },
  { name: "RAY", slug: "ray" },
];

export function Trusted() {
  return (
    <div className="border-t border-line pt-8">
      <div className="font-tech text-lg tracking-[0.2em] text-fog">
        <span className="text-lima">{"//"}</span> TRUSTED BY BUILDERS
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-x-10 gap-y-5">
        {BRANDS.map((b) => (
          <span key={b.slug} className="flex items-center gap-2.5 text-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`https://cdn.simpleicons.org/${b.slug}/ffffff`} alt="" width={22} height={22} loading="lazy" />
            <span className="font-tech text-2xl tracking-wide">{b.name}</span>
          </span>
        ))}
        <span className="flex items-center gap-2.5 text-white">
          <span className="flex h-[22px] w-[22px] items-center justify-center border border-white font-tech text-lg leading-none">
            V
          </span>
          <span className="font-tech text-2xl tracking-wide">vLLM</span>
        </span>
      </div>
    </div>
  );
}
