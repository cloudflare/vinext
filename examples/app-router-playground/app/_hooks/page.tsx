import Readme from './readme.mdx';
import { Prose } from '#/ui/prose';

export default function Page() {
  return (
    <div className="space-y-9">
      <Prose>
        <Readme />
      </Prose>
    </div>
  );
}
