'use client'

import ErrorPlaceholder from 'components/error-placeholder'

export default function Error({ error }) {
  return <ErrorPlaceholder error={error} />
}
