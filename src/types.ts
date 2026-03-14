export type UserRole = 'senior' | 'executive';

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  role: UserRole;
  assignedExecutiveId?: string;
  phoneNumber?: string;
  rut?: string; // Chilean ID commonly used in health plans
  address?: string;
  addressNumber?: string;
  apartment?: string;
  healthPlan?: string;
  dataConsentAccepted?: boolean;
  twoFAEnabled?: boolean;
}

export interface Office {
  id: string;
  name: string;
  address: string;
  distance?: string;
  lat: number;
  lng: number;
}

export interface SOSRequest {
  id?: string;
  seniorId: string;
  seniorName: string;
  executiveId: string;
  timestamp: any;
  status: 'pending' | 'attending' | 'resolved';
  location?: {
    lat: number;
    lng: number;
  };
}
