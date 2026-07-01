import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadingSpinner,
  Progress,
  RangeSlider,
  SimpleModal,
  Slider,
  Tabs,
  Tooltip,
  useToast,
} from "@/components/ui";
import { useState } from "react";

/**
 * TEMPORARY primitives gallery (Phase 2 "done when" check). Renders every UI primitive in
 * its variants for a quick visual + keyboard-a11y pass. Mounted at /dev/ui.
 * REMOVE this file and its route before the Phase 2 PR merges.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-serif text-xl text-text">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export function GalleryPage() {
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [single, setSingle] = useState(-40);
  const [range, setRange] = useState<[number, number]>([0.5, 3]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <h1 className="font-serif text-3xl text-accent">UI Primitives</h1>

      <Section title="Button">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button loading>Loading</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
      </Section>

      <Section title="Badge">
        <Badge>neutral</Badge>
        <Badge variant="accent">takbir</Badge>
        <Badge variant="accent-secondary">tasmi</Badge>
        <Badge variant="info">info</Badge>
        <Badge variant="success">success</Badge>
      </Section>

      <Section title="Card">
        <Card header="Card header" footer={<Button size="sm">Action</Button>} className="w-72">
          Card body content.
        </Card>
      </Section>

      <Section title="Input">
        <div className="w-72">
          <Input label="Label" placeholder="Placeholder" hint="Helper text" />
        </div>
        <div className="w-72">
          <Input label="Invalid" invalid hint="Something's wrong" defaultValue="bad" />
        </div>
      </Section>

      <Section title="Progress">
        <div className="w-72">
          <Progress value={0.4} />
        </div>
        <div className="w-72">
          <Progress />
        </div>
      </Section>

      <Section title="Slider">
        <Slider
          className="w-72"
          label="threshold_db"
          min={-60}
          max={-20}
          value={single}
          onChange={setSingle}
          format={(v) => `${v} dB`}
        />
        <RangeSlider
          className="w-72"
          label="duration"
          min={0}
          max={5}
          step={0.1}
          value={range}
          onChange={setRange}
          format={(v) => `${v.toFixed(1)}s`}
        />
      </Section>

      <Section title="Alert">
        <div className="flex w-full flex-col gap-2">
          <Alert variant="info" title="Info">
            Informational message.
          </Alert>
          <Alert variant="success" title="Success">
            It worked.
          </Alert>
          <Alert variant="warning" title="Warning">
            Heads up.
          </Alert>
          <Alert
            variant="error"
            title="Error"
            action={{ label: "Retry", onClick: () => toast("Retried", "info") }}
          >
            Something failed.
          </Alert>
        </div>
      </Section>

      <Section title="Spinner / Tooltip / Toast / Modal">
        <LoadingSpinner size={24} />
        <Tooltip content="Tooltip text">
          <Button variant="secondary" size="sm">
            Hover or focus
          </Button>
        </Tooltip>
        <Button size="sm" onClick={() => toast("Hello from a toast", "success")}>
          Show toast
        </Button>
        <Button size="sm" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
      </Section>

      <Section title="Tabs">
        <Tabs
          className="w-full"
          items={[
            {
              id: "a",
              label: "Silence",
              content: <p className="text-text-secondary">Silence panel.</p>,
            },
            {
              id: "b",
              label: "Markers",
              content: <p className="text-text-secondary">Markers panel.</p>,
            },
          ]}
        />
      </Section>

      <Section title="EmptyState">
        <div className="w-full">
          <EmptyState
            title="Nothing here"
            description="An empty state with an action."
            action={{ label: "Do something", onClick: () => toast("Did something", "info") }}
          />
        </div>
      </Section>

      <SimpleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Example modal"
        confirm={{ label: "Confirm", onClick: () => setModalOpen(false) }}
      >
        Modal body — try Tab/Shift+Tab and Escape.
      </SimpleModal>
    </div>
  );
}
