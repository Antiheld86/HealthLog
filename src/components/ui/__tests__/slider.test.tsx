/**
 * `<Slider>` / `<SliderField>` — the shape and the unanswered state.
 *
 * The suite renders server-side (`@testing-library/react` is not a dependency
 * here), so nothing below drags a thumb or presses an arrow key; the keyboard
 * behaviour is Radix's own contract and the manual pass covers it. What is
 * proven here is what the component decides: that an unanswered field renders
 * no number and announces itself as unanswered rather than as the value its
 * parked thumb sits on, that a zero is rendered as an answer, and that the
 * anchors reach the markup as muted legend text.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Slider, SliderField } from "../slider";

function field(props: Partial<React.ComponentProps<typeof SliderField>> = {}) {
  return renderToStaticMarkup(
    <SliderField
      label="Stress"
      value={7}
      onValueChange={() => {}}
      emptyLabel="nicht angegeben"
      valueText="7 von 10"
      lowAnchor="vollkommen entspannt"
      highAnchor="extrem belastet"
      {...props}
    />,
  );
}

describe("<Slider>", () => {
  it("renders the Radix parts under their slots", () => {
    const html = renderToStaticMarkup(
      <Slider value={[4]} min={0} max={10} step={1} />,
    );
    expect(html).toContain('data-slot="slider"');
    expect(html).toContain('data-slot="slider-track"');
    expect(html).toContain('data-slot="slider-range"');
    expect(html).toContain('data-slot="slider-thumb"');
  });

  it("announces the caller's text instead of the bare number", () => {
    const html = renderToStaticMarkup(
      <Slider
        value={[6]}
        min={0}
        max={10}
        valueText="6 von 10: sehr unangenehm bis sehr angenehm"
        thumbLabel="Stimmung"
      />,
    );
    expect(html).toContain(
      'aria-valuetext="6 von 10: sehr unangenehm bis sehr angenehm"',
    );
    expect(html).toContain('aria-label="Stimmung"');
    // The thumb is a slider to assistive tech, with the bounds published.
    // `aria-valuenow` is deliberately not asserted: Radix sets it after mount,
    // so it is absent from server markup and a test demanding it here would be
    // measuring the renderer rather than the component.
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-orientation="horizontal"');
  });
});

describe("<SliderField>", () => {
  it("renders the label, the value and both anchors", () => {
    const html = field();
    expect(html).toContain("Stress");
    expect(html).toContain("vollkommen entspannt");
    expect(html).toContain("extrem belastet");
    expect(html).toContain('data-slot="slider-field-value"');
    expect(html).toContain(">7<");
  });

  it("puts the answer in content colour and the anchors in muted", () => {
    const html = field();
    expect(html).toContain("tabular-nums");
    expect(html).toContain("text-foreground");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("text-xs");
  });

  it("renders an unanswered field as unanswered, not as its parked value", () => {
    const html = field({ value: null, valueText: "should not be announced" });
    expect(html).toContain('data-unset="true"');
    expect(html).toContain("nicht angegeben");
    // The thumb sits at the low end so the track reads empty, but nothing
    // claims that low end as the person's answer.
    expect(html).toContain('aria-valuetext="nicht angegeben"');
    expect(html).not.toContain("should not be announced");
  });

  it("renders a zero as an answer", () => {
    // Zero is a real point on this scale. A field that treated it as absence
    // would show the empty label and lose an answer somebody gave.
    const html = field({ value: 0, valueText: "0 von 10" });
    expect(html).not.toContain('data-unset="true"');
    expect(html).not.toContain("nicht angegeben");
    expect(html).toContain('aria-valuetext="0 von 10"');
  });

  it("offers to clear an answer only when there is one to clear", () => {
    const set = field({ onClear: () => {}, clearLabel: "zurücksetzen" });
    expect(set).toContain('data-slot="slider-field-clear"');
    expect(set).toContain("zurücksetzen");

    const unanswered = field({
      value: null,
      onClear: () => {},
      clearLabel: "zurücksetzen",
    });
    expect(unanswered).not.toContain('data-slot="slider-field-clear"');

    const noHandler = field();
    expect(noHandler).not.toContain('data-slot="slider-field-clear"');
  });
});
