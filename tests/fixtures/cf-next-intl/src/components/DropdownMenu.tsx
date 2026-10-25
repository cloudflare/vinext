import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {Link as NextIntlLink} from '@/i18n/navigation';

export default function DropdownMenu() {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger>Toggle dropdown</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content sideOffset={5} style={{backgroundColor: 'white'}}>
          <Dropdown.Item>Bar</Dropdown.Item>
          <Dropdown.Item asChild>
            <NextIntlLink href="/about">Link to about</NextIntlLink>
          </Dropdown.Item>
          <Dropdown.Item>Foo</Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
