import { collection, doc, setDoc, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { DEFAULT_SETTINGS } from '../constants/defaultSettings';

export async function seedDatabase() {
  const batch = writeBatch(db);
  const currentUser = auth.currentUser;

  // Seed Admin (Super Admin)
  const superAdminId = currentUser?.uid || 'super-admin-id';
  const superAdminRef = doc(db, 'admins', superAdminId);
  batch.set(superAdminRef, {
    name: currentUser?.displayName || 'Silas Kwesi',
    email: currentUser?.email || 'silas7korda@gmail.com',
    role: 'super_admin',
    status: 'active',
    lastLogin: new Date().toISOString(),
    createdAt: new Date().toISOString()
  });

  // Seed Artisans
  const artisans = [
    { id: 'art-001', name: 'Kofi Mensah', email: 'kofi@example.com', phone: '0241234567', category: 'Plumbing', rating: 4.8, jobs_completed: 156, status: 'active', earnings: 12450, joined: '2023-01-15T10:00:00Z', region: 'Greater Accra', avatar: 'KM' },
    { id: 'art-002', name: 'Abena Osei', email: 'abena@example.com', phone: '0247654321', category: 'Electrical', rating: 4.9, jobs_completed: 89, status: 'active', earnings: 8900, joined: '2023-03-20T14:30:00Z', region: 'Ashanti', avatar: 'AO' },
    { id: 'art-003', name: 'Kwame Boateng', email: 'kwame@example.com', phone: '0551122334', category: 'Carpentry', rating: 4.5, jobs_completed: 42, status: 'pending', earnings: 3200, joined: '2024-02-10T09:15:00Z', region: 'Western', avatar: 'KB' },
    { id: 'art-004', name: 'Esi Appiah', email: 'esi@example.com', phone: '0209988776', category: 'Cleaning', rating: 4.7, jobs_completed: 210, status: 'active', earnings: 5600, joined: '2022-11-05T11:45:00Z', region: 'Greater Accra', avatar: 'EA' }
  ];

  artisans.forEach(artisan => {
    const ref = doc(db, 'artisans', artisan.id);
    batch.set(ref, artisan);
  });

  // Seed Customers
  const customers = [
    { id: 'cust-001', name: 'John Doe', email: 'john@example.com', phone: '0240000001', location: 'East Legon, Accra', bookings: 12, spent: 4500, status: 'active', joined: '2023-05-10T08:00:00Z' },
    { id: 'cust-002', name: 'Jane Smith', email: 'jane@example.com', phone: '0240000002', location: 'Kumasi, Ashanti', bookings: 5, spent: 1200, status: 'active', joined: '2023-08-22T16:20:00Z' }
  ];

  customers.forEach(customer => {
    const ref = doc(db, 'customers', customer.id);
    batch.set(ref, customer);
  });

  // Seed Jobs
  const jobs = [
    { id: 'JOB-7281', category: 'Plumbing', customerId: 'cust-001', artisanId: 'art-001', amount: 450, status: 'Completed', createdAt: '2024-03-15T10:00:00Z', updatedAt: '2024-03-15T14:30:00Z', region: 'Greater Accra' },
    { id: 'JOB-7282', category: 'Electrical', customerId: 'cust-002', artisanId: 'art-002', amount: 300, status: 'In Progress', createdAt: '2024-03-17T09:00:00Z', updatedAt: '2024-03-17T11:00:00Z', region: 'Ashanti' },
    { id: 'JOB-7283', category: 'Cleaning', customerId: 'cust-001', artisanId: 'art-004', amount: 150, status: 'Pending', createdAt: '2024-03-17T15:00:00Z', updatedAt: '2024-03-17T15:00:00Z', region: 'Greater Accra' }
  ];

  jobs.forEach(job => {
    const ref = doc(db, 'jobs', job.id);
    batch.set(ref, job);
  });

  // Seed Regions
  const regions = [
    { id: 'greater-accra', name: 'Greater Accra', code: 'GA', active: true, createdAt: new Date().toISOString() },
    { id: 'ashanti', name: 'Ashanti', code: 'AS', active: true, createdAt: new Date().toISOString() },
    { id: 'western', name: 'Western', code: 'WR', active: true, createdAt: new Date().toISOString() },
    { id: 'central', name: 'Central', code: 'CR', active: true, createdAt: new Date().toISOString() },
    { id: 'eastern', name: 'Eastern', code: 'ER', active: true, createdAt: new Date().toISOString() },
    { id: 'volta', name: 'Volta', code: 'VR', active: true, createdAt: new Date().toISOString() },
    { id: 'northern', name: 'Northern', code: 'NR', active: true, createdAt: new Date().toISOString() },
    { id: 'upper-east', name: 'Upper East', code: 'UE', active: true, createdAt: new Date().toISOString() },
    { id: 'upper-west', name: 'Upper West', code: 'UW', active: true, createdAt: new Date().toISOString() },
    { id: 'bono', name: 'Bono', code: 'BR', active: true, createdAt: new Date().toISOString() },
    { id: 'bono-east', name: 'Bono East', code: 'BE', active: true, createdAt: new Date().toISOString() },
    { id: 'ahafo', name: 'Ahafo', code: 'AH', active: true, createdAt: new Date().toISOString() },
    { id: 'savannah', name: 'Savannah', code: 'SR', active: true, createdAt: new Date().toISOString() },
    { id: 'north-east', name: 'North East', code: 'NE', active: true, createdAt: new Date().toISOString() },
    { id: 'oti', name: 'Oti', code: 'OR', active: true, createdAt: new Date().toISOString() },
    { id: 'western-north', name: 'Western North', code: 'WN', active: true, createdAt: new Date().toISOString() }
  ];

  regions.forEach(region => {
    const ref = doc(db, 'regions', region.id);
    batch.set(ref, region);
  });

  // Seed Settings
  const settingsRef = doc(db, 'settings', 'platform');
  batch.set(settingsRef, DEFAULT_SETTINGS);

  await batch.commit();
  console.log('Database seeded successfully');
}
