/** A view may share elements with another view, as the editor and terminal do. */
export class ViewRegistry<Id extends string> {
  private readonly views = new Map<Id, readonly HTMLElement[]>();
  private readonly elements = new Set<HTMLElement>();

  register(id: Id, elements: readonly HTMLElement[]): void {
    if (this.views.has(id) || !elements.length) throw new Error(`Visualização inválida ou duplicada: ${id}`);
    this.views.set(id, elements);
    for (const element of elements) this.elements.add(element);
  }

  select(id: Id): void {
    const selected = this.views.get(id);
    if (!selected) throw new Error(`Visualização não registrada: ${id}`);
    const visible = new Set(selected);
    for (const element of this.elements) element.hidden = !visible.has(element);
  }
}
