// validation/schemas.js
const { z } = require('zod');

const email = z.string().trim().toLowerCase().email('must be a valid email address');
// Registration never enforced any password strength; reset-password only checked
// length. Applying the same floor everywhere closes that gap without being onerous.
const password = z.string().min(8, 'must be at least 8 characters');

const register = z.object({
    name: z.string().trim().min(1, 'is required'),
    email,
    role: z.enum(['organizer', 'vendor'], { errorMap: () => ({ message: "must be 'organizer' or 'vendor'" }) }),
    region: z.string().trim().optional().nullable(),
    password,
    phone: z.string().trim().optional().nullable(),
});

const login = z.object({
    email,
    password: z.string().min(1, 'is required'),
});

const forgotPassword = z.object({
    email: z.string().trim().min(1, 'is required'),
});

const resetPassword = z.object({
    email: z.string().trim().min(1, 'is required'),
    code: z.string().trim().min(1, 'is required'),
    newPassword: password,
});

const verifyOtp = z.object({
    email: z.string().trim().min(1, 'is required'),
    otp: z.string().trim().min(1, 'is required'),
});

const resendOtp = z.object({
    email: z.string().trim().min(1, 'is required'),
});

const createEvent = z.object({
    name: z.string().trim().optional().nullable(),
    event_type: z.string().trim().min(1, 'is required'),
    crowd_count: z.coerce.number().int().positive('must be a positive integer'),
    venue_size_sqm: z.coerce.number().positive().optional().nullable(),
    budget_range: z.string().trim().optional().nullable(),
    environment: z.enum(['Indoor', 'Outdoor']).optional(),
    requirements: z.array(z.string()).optional().nullable(),
    description: z.string().trim().optional().nullable(),
    location: z.string().trim().optional().nullable(),
    event_date: z.string().trim().optional().nullable(),
});

const createBid = z.object({
    event_id: z.coerce.number().int().positive('is required'),
    proposed_price: z.coerce.number().positive('must be a positive number'),
    notes: z.string().trim().optional().nullable(),
    bid_categories: z.array(z.string()).optional().nullable(),
    bid_items: z.array(z.unknown()).optional().nullable(),
});

const createRentalItem = z.object({
    equipmentSummary: z.string().trim().min(1, 'is required'),
    pricePerDay: z.coerce.number().positive('must be a positive number'),
    qty: z.coerce.number().int().positive().optional(),
    category: z.string().trim().optional(),
    photoUrl: z.string().optional().nullable(),
});

const bookRental = z.object({
    qtyToBook: z.coerce.number().int().positive().optional(),
    rentalDays: z.coerce.number().int().positive().optional(),
    paymentMode: z.string().trim().optional(),
});

const createReview = z.object({
    eventId: z.coerce.number().int().positive('is required'),
    vendorId: z.coerce.number().int().positive('is required'),
    rating: z.coerce.number().min(1).max(5),
    comment: z.string().trim().optional().nullable(),
});

const createRating = z.object({
    event_id: z.coerce.number().int().positive('is required'),
    vendor_id: z.coerce.number().int().positive('is required'),
    rating: z.coerce.number().min(1).max(5),
    review: z.string().trim().optional().nullable(),
});

module.exports = {
    register, login, forgotPassword, resetPassword, verifyOtp, resendOtp,
    createEvent, createBid, createRentalItem, bookRental, createRating, createReview,
};
