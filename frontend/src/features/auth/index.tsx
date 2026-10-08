import './Auth.css'

// Screens of the shell: LoginPage({expired, heading}) alone in place of any page for a guest — it draws its own
// <main> around the h1 the shell hands over; AccountPage({username}) at /account.
export { default as LoginPage } from './LoginPage'
export { default as AccountPage } from './AccountPage'
