const User = require("../model/user");
const axios = require("axios");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const fs = require("fs");
const Razorpay = require("razorpay");
const path = require("path");
const { generateCard, deleteFiles } = require("../controller/idcard");
const { sendWithAttachment } = require("../controller/mailController");
const expiryDate = require("../utils/expiryDate");
const AtheleteEnrollment = require("../model/athleteEnrollment");

dotenv.config();

const saltKey = process.env.SALT_KEY;
const merchantId = process.env.MERCHANT_ID;
const frontendURL = process.env.FRONTEND_URL;

// Initialize Razorpay instance using environment variables
const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID, // Use environment variables
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Multer for file uploads
const upload = multer({ dest: "uploads/" });

// Function to handle file uploads
const uploadFiles = (req, res) => {
    return new Promise((resolve, reject) => {
        const uploadSingle = upload.fields([
            { name: "photo", maxCount: 1 },
            { name: "certificate", maxCount: 1 },
            { name: "residentCertificate", maxCount: 1 },
            { name: "adharFrontPhoto", maxCount: 1 },
            { name: "adharBackPhoto", maxCount: 1 },
        ]);

        uploadSingle(req, res, (err) => {
            if (err) {
                return reject(err);
            }
            resolve(req.files);
        });
    });
};

// Function to upload files to Cloudinary
const uploadToCloudinary = async (filePath, folder) => {
    try {
        const result = await cloudinary.uploader.upload(filePath, {
            folder: folder,
        });
        return result.secure_url; // Return the URL of the uploaded file
    } catch (error) {
        console.error("Error uploading to Cloudinary:", error);
        throw error;
    }
};

const saveFileToRoot = async (filePath, filename) => {
    const rootDir = path.join(__dirname, "..", filename); // Save in root directory
    const readStream = fs.createReadStream(filePath);
    const writeStream = fs.createWriteStream(rootDir);

    return new Promise((resolve, reject) => {
        readStream.pipe(writeStream);

        writeStream.on("finish", () => {
            console.log(`File saved to root as ${filename}`);
            resolve(rootDir);
        });

        writeStream.on("error", (error) => {
            reject(error);
        });
    });
};

// Register function
exports.register = async (req, res, next) => {
    try {
        // Upload files using Multer
        const files = await uploadFiles(req, res);

        const {
            athleteName,
            fatherName,
            motherName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
            academyName,
            coachName,
        } = req.body;

        // Initialize file URLs
        let photoUrl,
            certificateUrl,
            residentCertificateUrl,
            adharFrontPhotoUrl,
            adharBackPhotoUrl;

        const regNo = `ATH${Date.now().toString()}`;

        // Upload each file to Cloudinary
        if (files.photo) {
            const fileName = `${regNo}-download.png`;
            await saveFileToRoot(files.photo[0].path, fileName);
            photoUrl = await uploadToCloudinary(files.photo[0].path, "uploads");
            fs.unlinkSync(files.photo[0].path); // Remove file after upload
        }
        if (files.certificate) {
            certificateUrl = await uploadToCloudinary(
                files.certificate[0].path,
                "uploads"
            );
            fs.unlinkSync(files.certificate[0].path);
        }
        if (files.residentCertificate) {
            residentCertificateUrl = await uploadToCloudinary(
                files.residentCertificate[0].path,
                "uploads"
            );
            fs.unlinkSync(files.residentCertificate[0].path);
        }
        if (files.adharFrontPhoto) {
            adharFrontPhotoUrl = await uploadToCloudinary(
                files.adharFrontPhoto[0].path,
                "uploads"
            );
            fs.unlinkSync(files.adharFrontPhoto[0].path);
        }
        if (files.adharBackPhoto) {
            adharBackPhotoUrl = await uploadToCloudinary(
                files.adharBackPhoto[0].path,
                "uploads"
            );
            fs.unlinkSync(files.adharBackPhoto[0].path);
        }

        // Create a new user in the database
        const newUser = await User.create({
            regNo,
            athleteName,
            fatherName,
            motherName,
            dob,
            gender,
            district,
            mob,
            email,
            adharNumber,
            address,
            pin,
            panNumber,
            academyName,
            coachName,
            photo: photoUrl,
            certificate: certificateUrl,
            residentCertificate: residentCertificateUrl,
            adharFrontPhoto: adharFrontPhotoUrl,
            adharBackPhoto: adharBackPhotoUrl,
        });

        // Prepare Razorpay order options
        const orderOptions = {
            amount: email === "info@jkta.in" ? 100 : 30000,
            currency: "INR",
            receipt: `order_rcptid_${newUser._id}`,
            payment_capture: 1, // Auto capture payment
        };

        // Create Razorpay order
        const order = await razorpayInstance.orders
            .create(orderOptions)
            .catch((error) => {
                console.error("Error creating Razorpay order:", error);
                res.status(500).json({
                    error: "An error occurred while creating the order.",
                });
            });
        // Send order details to the client for further processing
        res.status(200).json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            userId: newUser._id,
        });
    } catch (error) {
        console.error("Error in register function:", error);
        res.status(500).json({
            error: "An error occurred while registering the user.",
        });
    }
};

// Function to verify payment
exports.verifyPayment = async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            userId,
        } = req.body;

        // Generate the expected signature
        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET) // Use Razorpay key_secret
            .update(razorpay_order_id + "|" + razorpay_payment_id) // Concatenate order_id and payment_id
            .digest("hex");

        // Compare the generated signature with the signature received from Razorpay
        if (generatedSignature === razorpay_signature) {
            const userData = await User.findById(userId);
            //console.log(userData)
            // Payment verified successfully
            await User.findByIdAndUpdate(userData._id, { payment: true });

            const AthleteEnrollmentCount =
                await AtheleteEnrollment.countDocuments(); // as it returns a promise
            const AthleteEnrollmentDetails = await AtheleteEnrollment.create({
                enrollmentNumber: `JKTA${1000 + AthleteEnrollmentCount + 1}`,
                regNo: userData._id,
            });
            console.log(AthleteEnrollmentDetails);

            await generateCard({
                id: userData.regNo,
                enrollmentNo: AthleteEnrollmentDetails.enrollmentNumber,
                type: "A",
                name: userData.athleteName,
                parentage: userData.fatherName,
                gender: userData.gender,
                valid: expiryDate(userData.createdAt),
                district: userData.district,
                dob: `${userData.dob}`,
            });

            // upload pdf to cloudinary from root
            const pdfUrl = await uploadToCloudinary(
                `./${userData.regNo}-identity-card.pdf`,
                "idcards"
            );

            await sendWithAttachment(
              userData.email,
              "Here is your ID card from JKTA",
              "Please find your id card attatched below",
              "<p>Please find your id card attatched below</p>",
              `${userData.regNo}-identity-card.pdf`,
              `./${userData.regNo}-identity-card.pdf`
          );

            await deleteFiles(userData.regNo);
            res.status(201).json({
                message: "Email Sent successfully",
                success: true,
                paymentId: razorpay_payment_id,
                email: userData.email,
                regNo: userData.regNo,
                name: userData.athleteName,
                pdfUrl,
            });
        } else {
            // Payment verification failed
            res.status(400).json({
                success: false,
                message: "Payment verification failed",
            });
        }
    } catch (error) {
        console.error("Error in verifying payment:", error);
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
};
