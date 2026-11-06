import { useState } from 'react';
import { languages } from '@web/lib/toolchain';
import { newProject } from '@web/lib/projectActions';
import { Button, Dialog, Field, inputCls } from '../ui/primitives';

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('My Game');
  const [language, setLanguage] = useState('gdscript');
  const adapter = languages.get(language)!;
  const [template, setTemplate] = useState(adapter.templates[0]?.id ?? '');
  const [scriptName, setScriptName] = useState('Main');
  const valid = name.trim() && adapter.identifiers.isValid(scriptName) && !adapter.identifiers.reserved.has(scriptName);
  const create = async () => {
    if (!valid) return;
    onClose();
    await newProject(name.trim(), template, language, scriptName);
  };
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={create} data-testid="create-project">
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Project name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} data-testid="project-name" />
        </Field>
        <Field label="Language" hint="GDScript for Godot; TypeScript / JavaScript for web projects (ES modules).">
          <select className={inputCls} value={language} onChange={(e) => {
              setLanguage(e.target.value);
              setTemplate(languages.get(e.target.value)?.templates[0]?.id ?? '');
            }} data-testid="project-language">
            {languages.all().map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="First script name" hint={!adapter.identifiers.isValid(scriptName) ? adapter.identifiers.description : undefined}>
          <input className={inputCls} value={scriptName} onChange={(e) => setScriptName(e.target.value)} />
        </Field>
        <Field label="Script template">
          <div className="grid grid-cols-2 gap-2">
            {adapter.templates.map((t) => (
              <button type="button" key={t.id} onClick={() => setTemplate(t.id)} className={`rounded border p-2 text-left ${template === t.id ? 'border-accent bg-accent/10' : 'border-border hover:border-[#3a4253]'}`}>
                <div className="text-[12px] font-medium">{t.name}</div>
                <div className="text-[11px] text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
