'use client';

import {ReactNode, useActionState} from 'react';
import {FormResult} from './ZodFormExample';

type Props = {
  action(prev: unknown, data: FormData): Promise<FormResult>;
  children: ReactNode;
};

export default function ZodForm({action, children}: Props) {
  const [state, formAction] = useActionState(action, null);
  const hasErrors = state && !state.success;

  return (
    <form action={formAction}>
      {children}
      {hasErrors && <p>{state.errors.fieldErrors?.task?.join(', ')}</p>}
    </form>
  );
}
