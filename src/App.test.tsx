import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import App from './App'

afterEach(cleanup)

test('renders the placeholder application', () => {
  render(<App />)

  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    'Workout Companion',
  )
  expect(screen.getByText('Your personal workout tracker.')).toBeDefined()
  expect(
    screen.getByText('The application is ready for development.'),
  ).toBeDefined()
})
